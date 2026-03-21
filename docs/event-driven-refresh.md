# Event-Driven Refresh

Components are refreshable via server-pushed events over a persistent connection (WebSocket or SSE). This is an **opt-in** feature: only components that declare `static live = true` on the server are eligible for pushes (see [Component Definition](architecture.md#component-definition-server-side)). The rendering mode (`CSR`, `SERVER`, `SSR`, etc.) controls how a component initially fetches data; `live` controls whether the server can push updates afterward. The two are independent.

## Live Component Rules

- **`live` components** subscribe when they enter the DOM and unsubscribe when removed.
- **Non-`live` components** never subscribe, regardless of rendering mode. They work via normal request/response only.
- **Parent covers children.** If a parent is `live`, its subscription includes its children. Children of a live parent do not subscribe independently -- the parent handles updates for the whole subtree.
- **Independent live children.** If a child is `live` but its parent is not, the child subscribes independently and handles its own updates.

This keeps the subscription count naturally low: only explicitly live components subscribe, and the parent-covers-children rule further reduces the count since children of a live parent are covered for free.

## Subscription Registry

The server maintains a lightweight subscription registry that tracks which live components each client connection is currently displaying:

```
connections: {
  ws_abc: {
    "Table#dashboard": ["TableRow#0", "TableRow#1", "TableRow#2"],
    "Index": []
  }
}
```

The subscription lifecycle is tied to the component's presence in the DOM:

- **Subscribe** -- when a `live` component is rendered into the DOM, the client sends a subscribe message with the component ID and its current child IDs over the persistent connection.
- **Unsubscribe** -- when a `live` component is removed from the DOM (parent morph removes its mount point, or explicit destroy), the client sends an unsubscribe message immediately.
- **Connection close** -- when a WebSocket/SSE connection drops, the server clears all subscriptions for that connection.
- **Update children** -- when a live parent re-renders and its child list changes (children added/removed), the client sends an updated subscription with the new child IDs.

The registry is the "client shadow" -- it stores only IDs, not data or DOM state.

## Subscription Limits

The server enforces a **per-connection subscription cap** (e.g. 100 active subscriptions). If a client exceeds the limit, the server rejects the subscribe request -- the component still works via normal request/response, it just does not receive live pushes. This prevents a malicious or buggy client from overloading the server with subscriptions that each trigger `run()` calls on every data change.

## Push Flow

When the server detects a data change:

1. **Identify affected component.** The change originates from a data source; the server knows which component name(s) depend on it.
2. **Find subscribed clients.** Look up the subscription registry for connections viewing the affected component.
3. **Run the component.** For each subscribed client, run the component's `run()` method to produce the current state. Use the client's known children from the registry to compute `unchanged` markers.
4. **Push the response.** Send the Reactor-format JSON response directly over WebSocket/SSE. The client processes it through the normal render pipeline (DOM morph).

This avoids broadcasting raw change events to all clients (expensive and leaky) and avoids maintaining a heavy server-side DOM mirror. The subscription registry is the minimal state needed to compute targeted, efficient updates.

The parent-handles-children principle applies here too: if a child component's data changes, the server pushes an update for the **parent** that owns it. The parent response includes `unchanged` markers for unaffected children, and the client's morph pipeline handles the rest.

For connection drop recovery and reconnection behavior, see [Error Recovery](error-handling.md#live-push-connection-recovery).
