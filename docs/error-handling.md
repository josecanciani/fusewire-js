# Error Recovery

FuseWire handles errors at the component level, not the request level. A failure in one component does not break its siblings or parent. Errors bubble up the component tree until handled, with sensible defaults when no component intervenes.

## Protocol: Per-Component Error Markers

When a server-side `run()` throws, the Reactor catches the exception and serializes it as an error marker in the response. Other components in the same batch still succeed:

```json
{
  "fusewire-type": "response",
  "components": [
    {
      "fusewire-type": "component",
      "id": "Table#dashboard",
      "vars": { "headers": ["Name", "Email"] },
      "version": "a1b2c3d4e5f6"
    },
    {
      "fusewire-type": "error",
      "id": "Dashlet_ServerTime",
      "code": "RUN_FAILED",
      "message": "Database connection timeout",
      "retryable": true
    }
  ]
}
```

| Field       | Description |
|-------------|-------------|
| `code`      | Machine-readable error code (e.g. `RUN_FAILED`, `NOT_FOUND`, `TIMEOUT`). |
| `message`   | Human-readable description. Never exposed to end users by default -- it is for developer tooling and logging. |
| `retryable` | Hint from the server. `true` for transient failures (timeouts, upstream service errors), `false` for permanent ones (component not found, invalid vars). |

The HTTP status remains **200** as long as the Reactor successfully processed the request. Individual component failures are expressed in the JSON body, not via HTTP status codes. This keeps the protocol consistent: one request, one response, N component results.

## Client Error Handling: The `onError` Hook

Error handling follows a **bubbling model** similar to DOM events:

1. When a component receives an error response (or a client-side fetch/render fails), the framework calls `onError(error)` on the component instance.
2. If the component does not define `onError`, or if `onError` does not return `true`, the error **bubbles to the parent** component's `onError`.
3. Bubbling continues up the tree until a component handles the error (returns `true`).
4. If no component handles the error, the **default error behavior** applies (see below).

The `error` object passed to `onError` has the following shape:

```js
{
  componentId,   // ComponentId of the component that failed
  code,          // Error code string (from server or client-generated)
  message,       // Human-readable description
  retryable,     // Boolean hint
  source,        // 'server' | 'network' | 'template' | 'module' | 'render'
  retry(),       // Call to trigger an immediate retry of the failed operation
}
```

A component can use `onError` to set custom error state in its own vars and re-render, display a user-facing message, or trigger alternative behavior. Returning `true` stops bubbling.

## Default Error Behavior

When no component in the tree handles an error:

1. The failed component's container receives a `fusewire-error` CSS class.
2. The component renders a minimal framework-provided error placeholder (a simple message with a "Retry" button that calls `error.retry()`).
3. The error is logged to the browser console with full details.

Components can override this entirely by handling `onError` at any level of the tree.

## Retry Strategy

The framework distinguishes **retryable** and **non-retryable** errors:

| Error type | Examples | Behavior |
|------------|----------|----------|
| Retryable | Network failure, HTTP 5xx, `retryable: true` from server, template/module fetch timeout | Automatic retry with exponential backoff |
| Non-retryable | HTTP 4xx, `retryable: false` from server, JS syntax error | No automatic retry. Error surfaced immediately via `onError` / default behavior |

**Automatic retry** uses exponential backoff: delays of 1 s, 2 s, 4 s (3 attempts max by default). After all retries are exhausted, the error is surfaced through the normal `onError` bubbling path. Retry parameters are configurable via `config.js`:

```js
{
  retry: {
    maxAttempts: 3,     // Total attempts (including the original)
    baseDelay: 1000,    // Milliseconds before the first retry
    maxDelay: 8000,     // Cap on backoff growth
  }
}
```

During retries, the component keeps its current DOM state (no flicker). A `fusewire-retrying` CSS class is added to the container so the application can show a subtle loading indicator if desired.

## Timeouts

| Timeout | Default | Configurable via | Notes |
|---------|---------|-----------------|-------|
| **Client fetch** (Reactor POST) | 10 s | `config.js` → `timeout.reactor` | Uses `AbortController`. On timeout, treated as a retryable network error. |
| **Client fetch** (template GET) | 10 s | `config.js` → `timeout.template` | Same mechanism. |
| **Server `run()`** | 5 s | Server config (per-component or global) | If `run()` exceeds the limit, the server returns an error marker with `code: "TIMEOUT"` and `retryable: true`. |

## Optimistic UI Error Handling (SERVER Mode)

`SERVER` mode performs an immediate CSR pass (optimistic UI), then sends vars to the server. When the server returns an error:

1. The **optimistic UI is kept** -- no revert. Reverting would cause a jarring flash back to the previous state.
2. The component's container receives the `fusewire-error` CSS class so the application can style an error indicator (e.g. a banner, badge, or subtle border).
3. The `onError` hook is called, giving the component a chance to customize the error display or update its own vars.
4. If the error is retryable, automatic retry happens in the background. On success, the component re-renders with server data and the error class is removed.

## Template and Module Failures

**Template GET failures (non-404):**
- Network errors and 5xx responses are treated as retryable → automatic backoff retry.
- After all retries fail, the component enters the error state via `onError` bubbling.
- 404 is already handled: the client re-POSTs to the Reactor to get the updated version.

**JS module `import()` failures:**
- Network errors → retryable, automatic retry of the `import()` call.
- Syntax errors → non-retryable. The component enters the error state. The error is logged with the module URL for debugging.
- A component that fails to load its JS module cannot hydrate or become interactive, but its server-rendered HTML (if using SSR) remains visible.

## Partial Tree: Parent Succeeds, Child Fails

When a parent component renders successfully but one of its children fails:

1. The parent renders normally. Its DOM morph completes, and mount points for all children are placed.
2. Successful children render normally.
3. The failed child's mount point is preserved in the DOM. The error handling flow (`onError` bubbling → default error state) applies to the failed child independently.
4. If the error is retryable, the child retries on its own schedule.

The parent is not aware of the child failure unless its own `onError` hook receives the bubbled error. This keeps parent rendering fast and independent of child reliability.

## Live Push Connection Recovery

When the WebSocket/SSE connection drops:

1. The client attempts to **reconnect with exponential backoff** (same parameters as the retry config).
2. On successful reconnect, the client **re-subscribes** all currently-displayed live components.
3. To recover updates missed during the disconnection, the reconnect triggers a normal **Reactor POST for all live components**. This is effectively a full refresh of live data -- simple and correct, at the cost of one extra round trip.
4. While disconnected, live components continue to function via normal request/response (they just do not receive pushes). A `fusewire-disconnected` CSS class is added to the document body so the application can show a connectivity indicator.

## Error Codes

Standard error codes used by the framework:

| Code | Source | Retryable | Description |
|------|--------|-----------|-------------|
| `RUN_FAILED` | Server | Depends | The component's `run()` threw an exception. `retryable` depends on the exception type. |
| `TIMEOUT` | Server / Client | Yes | `run()` or fetch exceeded the configured timeout. |
| `NOT_FOUND` | Server | No | Component class not found on the server. |
| `NETWORK_ERROR` | Client | Yes | Fetch failed due to network issues. |
| `TEMPLATE_FETCH_FAILED` | Client | Yes | Template GET returned a non-404 error. |
| `MODULE_LOAD_FAILED` | Client | No | JS module `import()` failed (syntax error or missing export). |
| `RENDER_FAILED` | Client | No | Template compilation or DOM morph threw an exception. |
