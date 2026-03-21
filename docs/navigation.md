# Navigation

## Overview

FuseWire navigation is built on a simple principle: **the URL is a serialized snapshot of the active component tree's routing-relevant state**. Each component optionally contributes a small piece of state that defines its current "location." The framework collects these contributions, composes them into a URL, and can decompose that URL back into component states to reconstruct the view.

There is no centralized route table, no framework-level router, and no route configuration file. Components decide what state matters for navigation, and the framework handles serialization, history management, and reconstruction. This keeps navigation consistent with FuseWire's component-driven philosophy: each component owns its own concerns.

## Design Goals

### Component-Driven Navigation

Navigation follows the same ownership model as data and authorization. A component declares what state defines its "location" (e.g. which page, which search query, which selected item). The framework never dictates what a component's route state should be. Components that don't participate in navigation are invisible to the URL -- they work exactly as they do today.

### Graceful Degradation

If the URL references a component or state that no longer exists (a search result that disappeared, a deleted record, a permission change), the framework silently ignores the missing part. The component renders without that state. This makes URLs resilient to data changes -- a stale link produces a reasonable view, not an error.

### No Server Dependency by Default

Navigation works entirely client-side. The URL contains the full navigation state in a compact inline format. Server-stored short URLs are available as an opt-in feature for applications that need them, but the framework does not require a server round-trip to resolve a URL.

## Route State

### The Contract

A component opts into navigation by implementing two things:

| Declaration | Purpose |
|---|---|
| `static routeName` | A short alias used in the URL instead of the full component name. Must be unique among siblings (not globally). |
| `routeState()` | Returns a plain key/value object representing the minimal state needed to reconstruct this component's current view. |

Route state values can be:

| Type | URL encoding | Example |
|---|---|---|
| Primitive (string, number, boolean) | `key=value` | `page=2` |
| Routable component | `RouteName::id(state)` | `SearchResult(selected=Result::10)` |
| Array of routable components | Multiple entries with the same route name | `Tab::overview(...),Tab::settings(...)` |

### Defaults

Components can declare default values for their route state. When the current value matches the default, it is omitted from the URL to keep it compact:

```js
// Client-side component
export default class UserList extends Component {
  static routeName = 'Users';
  static routeDefaults = { page: 1, search: '' };

  routeState() {
    return {
      page: this.vars.page,
      search: this.vars.search,
      detail: this.vars.detail,  // a routable child component (or null)
    };
  }
}
```

If `page` is `1` and `search` is `''`, neither appears in the URL. If the user navigates to page 2 and opens a detail view, the URL includes only the non-default values.

### What to Include

Route state should contain only what is needed to **reconstruct the view**, not the full component data:

- **Include:** page number, search query, selected item ID, active tab, filter settings.
- **Exclude:** fetched data, computed values, UI-only state (hover, focus, animation progress). These come from the server (`run()`) or from Service Worker cache on reconstruction.

The server's `run()` is the authority. Route state values are input vars that `run()` reads to produce the correct data. The route state feeds into normal component execution -- it does not bypass it.

### Children in Route State

When a route state value is a component (or array of components), the framework recognizes it by type and recurses into it. The parent does not store the child's route state -- it only references the child by identity. The framework handles the child's route state independently.

```js
routeState() {
  return {
    search: this.vars.search,
    // The child component is included by reference.
    // Its own routeState() produces its own URL segment.
    detail: this.vars.selectedResult,
  };
}
```

If `this.vars.selectedResult` is a `ResultDetail` component with id `42` and its own route state `{ tab: 'activity' }`, the framework produces the nested URL segment automatically.

## URL Format

### Compact Tree Syntax

The URL encodes the navigation tree as a human-readable compact format using nested parentheses:

```
/RouteName(key=value,key=value,ChildName::id(key=value))
```

#### Grammar

```
url       = "/" segment
segment   = name [ "::" id ] [ "(" params ")" ]
params    = param { "," param }
param     = key "=" value
value     = literal | segment
name      = route alias (short, unique within parent)
id        = component instance id
literal   = URL-encoded string
```

#### Examples

Simple page with no state:
```
/Home
```

Page with primitive state:
```
/Users(page=2,search=alice)
```

Nested child with its own state:
```
/Users(search=alice,Detail::123(tab=activity))
```

Deeper nesting:
```
/Users(search=alice,Detail::123(tab=activity,Comments(sort=newest)))
```

Child component without additional state:
```
/Users(Detail::123)
```

#### Short Aliases

Components declare a `routeName` for use in URLs:

```js
export default class MainApp_UserListPage extends Component {
  static routeName = 'Users';
}
```

Since the URL is a tree, aliases only need to be unique among siblings -- the same alias can appear at different levels without ambiguity. This keeps URLs short and readable.

#### Instance IDs

The `::` separator distinguishes the component alias from its instance id:

```
Detail::123      → routeName "Detail", instance id "123"
Tab::settings    → routeName "Tab", instance id "settings"
Users            → routeName "Users", no instance id
```

The `::` separator is used instead of `#` because `#` is the URL fragment delimiter.

#### Escaping

Primitive values in route state may contain characters that are special in the URL syntax (`,`, `(`, `)`, `=`). The framework URL-encodes these characters using standard percent-encoding when serializing, and decodes them when parsing. Component-returned key/value objects contain raw values; the framework handles encoding transparently.

Only user-entered data typically needs escaping. Route state keys and component aliases are developer-defined and should use URL-safe characters.

## URL Composition

After a component renders (or re-renders after a `react()` call), the framework may update the URL to reflect the current navigation state.

### Collection

The framework walks the active component tree and collects `routeState()` from every routable component. Non-routable components (those without `routeState()`) are skipped -- they are invisible to the URL.

### Serialization

The collected tree is serialized into the compact URL syntax. Default values (matching `routeDefaults`) are stripped. The result is pushed to the browser history.

### Push vs. Replace

Not every state change warrants a new history entry. The component controls this through the `react()` call:

```js
this.react('SERVER', { route: 'push' });    // new history entry (e.g. opening a detail view)
this.react('SERVER', { route: 'replace' });  // update current entry (e.g. typing in a search box)
```

When `route` is not specified, the framework does not update the URL. This preserves backward compatibility -- existing components that don't participate in navigation behave exactly as before.

## URL Decomposition and Reconstruction

When the framework needs to reconstruct a view from a URL (back/forward button, shared link, direct navigation), it parses the URL into a tree of route segments and applies them top-down through the component tree.

### The Reconstruction Flow

1. **Parse the URL** into a tree: `{ name, id, state, children }`.
2. **Find or create the root component.** Apply the root segment's state as initial vars.
3. **Run the component normally.** The route state values become input vars for `run()`. The component executes its normal logic -- queries data, creates children -- using those vars.
4. **Find route children in the result.** After `run()` completes (and before or after render, depending on rendering mode -- see [Timing](#reconstruction-timing)), the framework searches the component's children for matches against the URL tree's child segments, matching by route name and instance id.
5. **Apply route state to matched children** and repeat from step 3 recursively.
6. **Ignore unmatched segments.** If a URL segment references a child that doesn't exist in the rendered tree (data changed, permissions revoked, etc.), it is silently skipped.

### Reconstruction Timing

When the framework can apply route state to children depends on the component's rendering mode:

| Mode | When children are known | Route state applied |
|---|---|---|
| CSR / CSR_ONLY | After local template execution, before DOM render | Pre-render -- no extra render cycle |
| SERVER / SERVER_WAIT / SSR | After the server responds | Post-response, before child render |

In both cases, route state is applied before the child component renders for the first time. The difference is whether a server round-trip is needed to determine what children exist.

For server-side components, reconstruction is necessarily sequential: render parent → wait for server → find children → apply route state → repeat. Each level is a separate Reactor request. This is acceptable because:

- It only happens during URL-based reconstruction (back button, shared link), not during normal in-app navigation.
- Each step benefits from Service Worker cache (stale-while-revalidate), so the user sees progressive rendering.
- The parent renders immediately while children are still loading.

### Same-Browser Navigation (Back/Forward)

When the user presses back or forward, the browser fires a `popstate` event. The framework:

1. Parses the restored URL into a route tree.
2. Diffs the route tree against the current live component tree.
3. For components that exist and have the same route state: no-op.
4. For components that exist but have different route state: updates their vars and triggers `react()`.
5. For components in the URL but not in the DOM: creates them "from URL" with route state + Service Worker cached vars.
6. For components in the DOM but not in the URL: destroys them through the normal lifecycle (`destroy()` hook).

Since the Service Worker cache holds vars from previous visits, reconstruction on the same browser is fast -- the component renders from cache immediately (stale-while-revalidate) and refreshes from the server in the background.

### Cross-Browser Navigation (Shared Links)

When a user opens a URL in a different browser (no Service Worker cache):

1. The framework parses the URL and starts reconstruction.
2. Components are created with only the route state as initial vars (no cached data).
3. Each component's `run()` on the server populates the full data from the route state inputs.
4. With SSR, the server renders the complete HTML on the first request -- the user sees the correct page immediately.

The route state must contain enough information for `run()` to produce the right result. For example, if `UserList` has `routeState` `{ page: 2, search: 'alice' }`, then `run()` can query users filtered by "alice" on page 2. The URL doesn't carry the query results -- just the parameters needed to reproduce them.

## Server-Stored URLs

### Motivation

For complex navigation trees, the inline URL can become long. As an opt-in feature, the framework provides an endpoint to store navigation state server-side and return a short identifier:

```
POST /fusewire/nav
Content-Type: application/json

{
  "tree": { "n": "Users", "s": { "page": 2 }, "c": { ... } }
}

→ { "id": "x7f2k" }
```

The short URL `https://app.example.com/p/x7f2k` resolves the stored tree and reconstructs the view.

### Storage Backend

The framework provides a default session-scoped storage backend (navigation IDs live for the lifetime of the server process). Applications can replace this with any implementation that satisfies the storage interface:

```js
// Storage interface
{
  save(tree)           // → Promise<string> (short id)
  resolve(id)          // → Promise<object|null> (tree or null if expired/missing)
}
```

This allows applications to use Redis, a database, or any other backend depending on their durability and sharing requirements.

### Default Behavior

**The framework does not store navigation server-side by default.** Inline URLs are the default. This keeps the framework simple and encourages developers to keep route state minimal. The short URL endpoint is available for applications that need it, but it is not used automatically.

## Integration with Existing Features

### Caching and Instance Cleanup

Navigation interacts naturally with the existing caching and cleanup mechanisms:

- **Service Worker cache**: Components visited during navigation have their vars cached. On back-button navigation, cached vars provide instant rendering before the server responds.
- **Instance cleanup**: When navigation destroys components (user navigates away), the normal cleanup flow applies (`destroy()` hook, registry removal). Cached vars persist for fast recreation if the user navigates back.
- **Stale-while-revalidate**: URL reconstruction uses the same pattern as cache-aware rendering. Components render from available state (route state + cache) immediately, then refresh from the server.

### Rendering Modes

Navigation does not introduce new rendering modes. Route state values are just vars -- they flow through the existing rendering pipeline:

- **SSR**: On initial page load, the server parses the URL, applies route state, and renders the full HTML. This is the recommended mode for URL-based entry points.
- **SERVER**: Normal in-app navigation uses `react('SERVER', { route: 'push' })`. The optimistic UI pattern applies -- the component renders immediately with the new route state, then refreshes from the server.
- **CSR/CSR_ONLY**: Client-only components can participate in navigation. Their route state is applied locally without a server round-trip.

### Live Components

Live components (server-pushed updates) work independently of navigation. A live component that is part of the current navigation state receives pushes normally. When navigation destroys it, it unsubscribes. When navigation recreates it (back button), it re-subscribes.

### Error Recovery

If a component fails during URL reconstruction (server error, missing data), the normal error recovery flow applies. The failed component enters the error state; its parent and siblings are unaffected. The URL reconstruction continues for the rest of the tree -- one failed component does not block the others.
