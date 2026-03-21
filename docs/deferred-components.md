# Deferred Components

## Problem

When a component tree is large or some children are expensive to compute, returning the entire tree in a single Reactor response creates two problems:

1. **Slow children block fast ones.** A parent with ten children waits for all ten `run()` calls to complete before the client sees anything. One 5-second report query delays the entire response.
2. **Large responses delay first paint.** Even if all children are fast individually, serializing a deep tree adds up. The user cannot see the parent until every descendant is ready.

Deferred rendering solves both by letting the server return completed children immediately and mark incomplete ones for later fetching. The client renders what it has, then progressively fills in the rest.

## Protocol

### Deferred Marker

A new `fusewire-type: "deferred"` response type for child components:

```json
{
  "fusewire-type": "deferred",
  "id": "ExpensiveChart#main",
  "vars": { "dateRange": "last-30d" },
  "version": "a1b2c3d4e5f6",
  "slow": false
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `fusewire-type` | Yes | Always `"deferred"`. |
| `id` | Yes | Component identity (`name#instanceId`). |
| `vars` | Yes | Default vars set by the parent during `run()`. The client uses these to render an initial version of the component and sends them back when fetching the full data. |
| `version` | No | Template version, if known. Lets the client prefetch the template while waiting for the deferred data. |
| `slow` | No | If `true`, the client must batch this component separately from non-slow deferred children. Defaults to `false`. |

### Updated Child Response Types

The child response type table (see [architecture.md](architecture.md#unchanged-components)) gains a `deferred` row:

| Response type | Client has cached vars? | Action |
|---|---|---|
| `component` (full data) | -- | Create or update instance, render. |
| `unchanged` | -- | Keep existing instance, no re-render. |
| `deferred` | Yes | Render from cache immediately, fetch fresh data from server. |
| `deferred` | No | Instantiate with default vars from the marker, render, fetch from server. |
| `error` | -- | Enter error state, trigger `onError` bubbling. |
| Absent | -- | Call `destroy()`, remove from DOM. |

### Fetching Deferred Children

The client fetches deferred children with a standard Reactor POST. Each deferred child is sent as a top-level component request using the `id` and `vars` from the deferred marker:

```json
POST /fusewire
Content-Type: application/json

{
  "components": [
    {
      "fusewire-type": "component",
      "mode": "SERVER",
      "id": "ExpensiveChart#main",
      "vars": { "dateRange": "last-30d" }
    }
  ]
}
```

The server instantiates the component, calls `run()`, and returns the full component data through the normal Reactor response format. No new endpoint is needed.

## Server-Side Behavior

### Time Budget

The server applies a configurable time budget (default TBD, e.g. 200 ms) when processing a component's children during serialization:

1. Sort children: non-slow first (declaration order), then slow.
2. Run each child's `run()` sequentially.
3. After each child completes, check elapsed time.
4. If the budget is exceeded, serialize all remaining children as `deferred` without calling their `run()`.

Children that complete within the budget are serialized as full `component` responses with their computed vars. The time budget ensures the parent response stays fast regardless of how many children exist or how expensive some of them are.

### The `slow` Marking

Components can declare themselves as slow:

```js
export default class MonthlyReport extends Component {
  static slow = true;

  run() {
    // expensive aggregation queries
  }
}
```

`slow` is a **hint**, not an absolute skip. Its effects:

1. **Server execution order.** Slow children are sorted to the end of the execution queue. This maximizes the number of fast children that complete within the time budget.
2. **Server budget behavior.** If time remains after all non-slow children complete, the server starts running slow children. A slow child that completes within the remaining budget is serialized as a full `component` -- not deferred.
3. **Client request batching.** When the client fetches deferred children, it separates slow and non-slow into different Reactor requests (see [Request Batching](#request-batching)).

### Explicit Deferral

A parent can also defer a child explicitly in `run()`, regardless of time budget or `slow` marking:

```js
run() {
  this.summary = new DashboardSummary('main', { period: 'today' });         // run immediately
  this.chart = this.defer(ExpensiveChart, 'main', { dateRange: 'last-30d' }); // always deferred
}
```

`this.defer()` creates a component instance with the given vars and marks it for deferred serialization. The child's `run()` is never called during this request. The serializer emits a `deferred` marker with the vars and the `slow` flag from the child's class definition.

## Client-Side Behavior

### Rendering Deferred Components

When the client receives a `deferred` marker in a response:

1. **Check cache.** If cached vars exist for this component ID (from a previous render), use them to render immediately ([stale-while-revalidate](architecture.md#cache-aware-rendering-stale-while-revalidate)).
2. **No cache.** Instantiate the component with the default `vars` from the deferred marker. Render with the component's normal template. The result may be minimal or empty depending on the default vars -- this is the developer's responsibility.
3. **Add CSS class.** Add `fusewire-deferred` to the component's container element.
4. **Fetch from server.** Queue a Reactor request for the deferred component (see [Request Batching](#request-batching)).
5. **Server responds.** Update vars, re-render, remove `fusewire-deferred` class.

The component is a live, interactive instance during the deferred state. The developer can use the `fusewire-deferred` CSS class to signal loading status. The framework does not inject placeholder HTML; the component's own template and default vars control the visual state.

### Request Batching

After rendering a parent with deferred children, the client sends **two parallel Reactor requests**:

1. **Fast batch.** All deferred children where `slow` is `false` or absent.
2. **Slow batch.** All deferred children where `slow` is `true`.

This separation ensures fast deferred children are not blocked by slow ones sharing the same HTTP response. Each batch is a standard Reactor POST containing multiple components.

### Progressive Loading

The time budget applies at every level. When the server processes a batch of deferred children, it again applies the budget:

- Children that complete within the budget are returned as full `component` responses.
- Children that exceed the budget are returned as `deferred` again.

The client handles the new `deferred` markers the same way: render what it has, fetch the rest. This creates a natural multi-round loading cycle until everything resolves:

```
Round 1: Client requests parent.
         Server returns parent + 3 fast children + 2 deferred (slow).

Round 2: Client requests 2 slow deferred children (slow batch).
         Server runs child A (fast this time), defers child B (still slow).
         Client renders child A.

Round 3: Client requests child B.
         Server runs child B, returns full data.
         Client renders child B. Done.
```

### Recursive Deferral

A deferred child's response may itself contain deferred grandchildren. The client handles these with the same mechanism -- no special case. The progressive loading model applies recursively through the entire tree.

### Children Array and Deferred State

The `children` array in a Reactor request lists children the client holds with **up-to-date server data**. A deferred child that the client is rendering from cache or default vars is not up-to-date -- it should **not** appear in `children`. This means on a parent re-request, the server will treat the still-deferred child as a new child: it will either run it (if time permits) or defer it again.

Once the client successfully fetches a deferred child via a separate Reactor request, the child has up-to-date data and should appear in `children` on subsequent parent requests. The server can then return `unchanged` for it if nothing changed.

## CSS

The framework adds `fusewire-deferred` to a component's container while it is in the deferred state (rendered with default or cached vars, waiting for fresh server data). The class is removed when the server response arrives and the component re-renders.

This follows the same pattern as `fusewire-refreshing` ([stale-while-revalidate](architecture.md#cache-aware-rendering-stale-while-revalidate)) and `fusewire-error` ([error recovery](architecture.md#error-recovery)). Developers can style accordingly:

```css
/* loading cursor on the deferred component itself */
.fusewire-deferred {
  cursor: progress;
}

/* dim a parent that has deferred children */
.my-dashboard:has(.fusewire-deferred) {
  opacity: 0.8;
}
```

## Interaction with Other Features

### Live Components (Event-Driven Refresh)

Push responses use the same mechanism. When the server pushes an update for a `live` parent, it applies the time budget to the push serialization. Slow or timed-out children appear as `deferred` in the push response, and the client handles them identically to a normal Reactor response.

See [docs/event-driven-refresh.md](event-driven-refresh.md) for the live push model.

### Unchanged Components

If the client already holds a fully rendered (non-deferred) child and the server determines it has not changed, the server sends `unchanged` as usual. `deferred` only applies to children whose `run()` was not executed in the current request.

### Error Recovery

If a Reactor request for a deferred component fails, the normal error recovery flow applies: `fusewire-type: "error"`, `onError` bubbling, retry with exponential backoff. The cached or default-var render is kept -- the user sees stale data with an error indicator rather than nothing.

See [docs/error-handling.md](error-handling.md) for the full error recovery model.

### Caching

Deferred markers include `version` when available, allowing the client to prefetch templates via the [template endpoint](architecture.md#template-endpoint) while waiting for the deferred data. Combined with cached vars, this means a previously-seen deferred component can render from cache with full template and data immediately, then refresh when the server responds.
