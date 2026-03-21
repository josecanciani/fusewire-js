# Architecture

## Overview

FuseWire is a component-based framework for building browser applications. HTML, CSS, and JavaScript are kept as separate files -- there is no JSX or single-file component format. The server manages component data and templates; the browser manages rendering, caching, and user interaction.

FuseWire-JS is the Node.js/Express 5 server implementation. The system has two main parts:

1. **Server (this project)** -- an Express 5 application that hosts the Reactor API endpoint and serves static assets (including the client framework).
2. **Client framework** -- a set of browser ES modules (served from `/js/fusewire/`) that handle rendering, caching, and server communication.

## Design Goals

### No API Layer for UI Data

FuseWire deliberately eliminates the traditional API layer between UI components and data. In a typical web application, the client calls REST or GraphQL endpoints, the server handles those endpoints, and developers maintain an explicit contract (routes, schemas, serialization) between the two sides. FuseWire replaces this with a **component-driven data model**: each component declares the data it needs as server-side properties, and the `run()` method wires those properties to whatever internal data sources the application uses (databases, services, caches, etc.). The framework protocol delivers the resulting data to the client transparently.

From the UI developer's perspective, there are no endpoints to define, no fetch calls to write, and no request/response contracts to maintain per component. The developer's responsibility is:

1. **Define component vars** -- declare the shape of the data the component needs.
2. **Implement `run()`** -- populate those vars from internal data sources.
3. **Write the template** -- render the vars as HTML.

The framework handles everything in between: serialization, transport, caching, versioning, and incremental updates. This keeps UI code focused on presentation and keeps data-access logic colocated with the component that needs it, rather than scattered across a separate API surface.

### Authorization Is the Component's Responsibility

FuseWire deliberately has no authentication or authorization model. The Reactor endpoint accepts component class names directly from the client, and the framework makes no attempt to restrict which components a client can request.

This is by design. Each component's `run()` method has full access to the request context (session, cookies, headers) and is responsible for deciding whether the current user is allowed to see its data. If the user lacks permission, `run()` should throw or return an appropriate error. The framework catches the exception and serializes it as a per-component error marker (see [Error Recovery](#error-recovery)), so one denied component does not break its siblings.

This keeps authorization logic colocated with the data it protects -- the same `run()` method that queries the database also enforces who can see the result -- rather than duplicating access rules in a framework-level middleware layer that would need to understand every component's permission model.

A future protocol addition may introduce a dedicated `fusewire-type: "access-denied"` marker (analogous to the existing `error` type) so that the client can render a standardized "not authorized" placeholder (e.g. a lock icon) instead of a generic error.

### Separation of Concerns Without a Build Step

HTML templates, CSS styles, JavaScript classes, and server logic are kept as separate plain files -- no JSX, no single-file components, no compilation. This is a deliberate trade-off: it preserves standard tooling (HTML validators, CSS linters, JS debuggers) and avoids lock-in to a custom file format or build pipeline.

### Style Isolation Without Shadow DOM

FuseWire uses **class-based CSS scoping** (each component's styles are prefixed with a container class) instead of Shadow DOM. Shadow DOM was considered and intentionally rejected as the default because its costs outweigh its benefits in FuseWire's architecture:

**Why Shadow DOM is attractive:**
- True style encapsulation -- CSS cannot leak in or out of a component boundary.

**Why it conflicts with FuseWire's design:**

| Problem | Impact on FuseWire |
|---|---|
| **DOM morphing** | idiomorph operates on a single DOM tree. Shadow roots create separate document fragments; the morpher would need shadow-aware traversal to diff and patch across boundaries. |
| **Child mount points** | `data-fusewire-id` attributes inside a parent's shadow root are invisible to `querySelector` from outside. The instance registry and renderer would need to walk shadow boundaries explicitly. |
| **Global styles** | CSS resets, design tokens, and typography rules do not penetrate shadow boundaries. Every component would need to duplicate or `@import` shared styles into its shadow root, increasing payload and maintenance burden. |
| **Form participation** | `<input>`, `<select>`, and other form elements inside shadow DOM do not participate in an ancestor `<form>`. The `ElementInternals` API is the workaround, but it adds significant boilerplate and has limited browser support. |
| **Accessibility** | ARIA cross-references (`aria-labelledby`, `aria-describedby`) and `<label for="...">` / `id` pairs cannot cross shadow boundaries. Screen readers have historically had inconsistent support for shadow DOM content. |
| **Event delegation** | Events that originate inside shadow DOM are retargeted at the shadow host, breaking delegation patterns on ancestor elements. |

**Recommendation:** Use the default class-based scoping for all normal application components. FuseWire's component model already provides natural isolation -- the framework controls the DOM tree, so application code rarely needs global queries or unscoped selectors. Class-based scoping handles the common case (preventing style collisions between components) without any of the above costs.

Shadow DOM may be revisited in the future for a narrow use case: **embedding FuseWire components as widgets inside third-party pages** where the host page's styles are unknown and uncontrollable. This would be an explicit opt-in per component, not a framework default.

## Core Concepts

### Components

A component is the fundamental building block. All files for a component are **colocated** in the same directory, sharing the same base name:

| File              | Purpose                              | Required |
|-------------------|--------------------------------------|----------|
| `Name.server.js`  | Server-side data logic (`run()`)    | No (component can be client-only) |
| `Name.js`         | Client-side class (extends `Component`) | Yes (auto-generated if absent) |
| `Name.html`       | HTML template for rendering          | No (only needed if the component is rendered) |
| `Name.css`        | Scoped styles                       | No       |

In non-JavaScript server implementations the server-side file naturally has a different extension (e.g. `Name.php`, `Name.py`). In JavaScript the `.server.js` suffix distinguishes server code from the client `.js` module. The server **must never** expose `.server.js` files to the browser.

This separation is a core design principle: HTML templates are plain HTML with template directives, JS files are plain ES module classes, and CSS files are plain CSS. No compilation or build step is required.

#### Directory Layout

Components live under `src/components/`. The directory path maps to the component name using `_` as a separator:

```
src/components/
  Index.server.js            # component name: Index
  Index.js
  Index.html
  Index.css
  Dashlet/
    ServerTime.server.js     # component name: Dashlet_ServerTime
    ServerTime.js
    ServerTime.html
    ServerTime.css
```

The server mounts this directory at `/js/components/` with a filter that excludes `*.server.js` files, so that client files are fetchable transparently at predictable URLs (e.g. `/js/components/Dashlet/ServerTime.js`). No manual per-component route registration is needed.

### Component Identity

Every component has a **name** (derived from its module path, e.g. `Dashlet_ServerTime`) and an optional **id** for distinguishing multiple instances of the same component.

In code, identity is represented as a structured `ComponentId` object with `name` and `id` properties -- not as a concatenated string. This avoids delimiter collisions (component names already contain underscores). Helper constructors parse serialized forms:

```js
// Construction
const cid = new ComponentId('Dashlet_ServerTime', 'sidebar');
cid.name  // 'Dashlet_ServerTime'
cid.id    // 'sidebar'

// From a serialized code string (e.g. from the DOM or protocol)
const cid = ComponentId.fromCode('Dashlet_ServerTime#sidebar');
```

When a string representation is needed (DOM attributes, cache keys, protocol fields), the format is `{name}#{id}`. When the id is empty, the trailing `#` is omitted (e.g. `Dashlet_ServerTime`). The `#` separator is unambiguous because component names only contain word characters and underscores.

### Versioning

Templates and component data are versioned. The version is a short hex string derived from a **content hash** of the component's files (`.html`, `.css`, `.js`). Previous implementations used the file modification timestamp, but mtimes are unreliable across deployments (containers and CI pipelines reset them). Content hashing is deterministic -- the same files always produce the same version, regardless of when or where they were built -- which means clients keep their cached templates across redeployments that don't change component files.

The server computes versions using SHA-256 (truncated to 12 hex characters) via the `node:crypto` built-in module and caches results in memory. In production the cache lives for the lifetime of the process (restart to pick up new files). In development the cache can be invalidated on file change.

The client sends its known version when requesting data; the server can skip sending the template if the client already has it. This enables efficient caching and selective reloading.

### Templates

A template is the bundle of HTML and CSS for a component. Templates are:
- Fetched via a dedicated `GET` endpoint that supports standard HTTP caching (see [Template Endpoint](#template-endpoint)).
- Cached in the browser via the Cache API (managed by a Service Worker), keyed by component name.
- Versioned so the client only re-fetches when the version changes.

Component JS modules are **not** part of the template. They are served as standard ES module files with proper MIME types (`application/javascript`) and loaded via dynamic `import()`. This keeps the framework compatible with strict Content Security Policies -- no `blob:` or `unsafe-eval` required in `script-src`. See [Caching Strategy](#caching-strategy) for how the Service Worker handles JS module caching and first-load performance.

#### Template Syntax

Templates are plain HTML files with two kinds of dynamic features:

**Variable interpolation** uses `(( ))` delimiters:
- `((variableName))` -- render a variable value. If the variable is a component (or array of components), the renderer expands it into mount-point elements automatically.
- `((this))` -- reference to the component instance (for event handlers in HTML).

**Control-flow directives** use `fw-` prefixed HTML attributes:
- `fw-if="expression"` -- conditionally render the element. The expression is a simple property path with optional `!` negation (not arbitrary JS).
- `fw-each="item in collection"` -- repeat the element for each item in the collection.

Example:

```html
<h1>((title))</h1>
<p fw-if="showDescription">((description))</p>
<ul fw-if="items.length">
  <li fw-each="item in items">((item.name)): ((item.value))</li>
</ul>
<p fw-if="!items.length">No items yet.</p>
```

This keeps templates as valid, parseable HTML. No JS code in templates.

### DOM Updates

When a component's vars change, FuseWire re-runs the compiled template with the new vars to produce an HTML string, then uses **DOM morphing** (idiomorph) to patch the current DOM. The morpher diffs old vs new DOM and applies the minimal set of mutations -- unchanged text nodes, attributes, and elements are left untouched.

Child component mount points are matched by their `data-fusewire-id` attribute and preserved -- their subtrees are never touched by the parent's morph. The parent only passes updated data down to children for their own independent render cycle.

## Rendering Modes

The framework supports multiple rendering strategies. A component can switch modes at runtime per reaction:

| Mode          | Description |
|---------------|-------------|
| `CSR`         | **Client-Side Rendering.** Uses the cached template and current client variables. Falls back to `SERVER` if no template is cached. |
| `CSR_ONLY`    | **Client-only.** No server interaction at all. Templates are fetched as static files. |
| `SERVER`      | **Server with optimistic UI.** Immediately does a CSR pass for fast feedback, then sends vars to the server. When the server responds, updates vars and re-renders. |
| `SERVER_WAIT` | **Server blocking.** Sends vars to the server and waits. No UI update until the response arrives. |
| `SSR`         | **Server-Side Rendering.** The server returns fully rendered HTML (HTML-over-the-wire). The page is visible immediately; components become interactive progressively as their JS modules load and `hydrate()` runs. This is the recommended mode for initial page loads. |

## Component Lifecycle

```
1. start(container, componentName, id, vars, mode)
       |
2. Fetch component data from server (if mode requires it)
       |-- POST to Reactor endpoint with component vars
       |-- Server: instantiates component, runs it, returns vars + template version
       |
3. Fetch template (if needed)
       |-- Check local cache for template at the version from step 2
       |-- On cache miss: GET /fusewire/templates/:name/:version (HTTP-cacheable)
       |
4. Create or update instance
       |-- If new: import JS module via dynamic import(), instantiate class, set vars, call hydrate()
       |-- If existing: update vars, call update(oldVars)
       |
5. Render
       |-- Re-run compiled template with new vars, DOM-morph against current DOM
       |-- Morpher preserves child mount points (matched by data-fusewire-id)
       |-- Add CSS <style> to document head, scoped by container class
       |-- Pass updated data to child components for their own render cycle
       |
6. afterRender callback (user-defined, e.g. animations)
       |
7. User interaction triggers react(mode) --> back to step 2
```

### Lifecycle Hooks

| Hook         | When                                      | Async | Notes |
|--------------|-------------------------------------------|-------|-------|
| `hydrate()`  | After first creation or server var update, before render | Yes | Safe for async init work |
| `update(oldVars)` | After server vars are updated on an existing instance | No | Synchronous to avoid race conditions |
| `onError(error)` | When a server fetch or render fails for this component or an unhandled child | No | Return `true` to mark as handled and stop bubbling. See [Error Recovery](#error-recovery). |
| `destroy()`  | When the instance is removed               | No  | Cleanup logic |

## Component Tree

Components can contain child components. A server variable whose value is a Component is serialized with `fusewire-type: "component"` and rendered as a mount-point element (with a `data-fusewire-id` attribute) in the parent's HTML. The framework recursively creates, fetches, and renders child components. Arrays of Components are expanded into multiple mount points.

```
Index (root)
  |-- counter: 0 (plain variable)
  |-- serverDateString: Dashlet_ServerTime (child component)
        |-- serverDateString: "Thursday, 19-Mar-26 ..." (plain variable)
```

## Client-Server Protocol

Communication uses two endpoints:

- **`POST /fusewire`** -- the Reactor endpoint. Handles dynamic component data (vars, children, lifecycle). Request and response use `application/json`.
- **`GET /fusewire/templates/:componentName/:version`** -- serves component templates (HTML, CSS, JS URL). Responses are immutable and HTTP-cacheable.

This split lets CDNs and browser HTTP caches serve templates directly, while dynamic component data flows through the Reactor as before.

Component identity uses a single string field `id` with the format `{name}#{id}` (e.g. `Table#dashboard`, `TableRow#0`). When the instance id is empty, the `#` is omitted (e.g. `Dashlet_ServerTime`). A `ComponentId` helper parses this into separate `name` and `id` properties.

### Reactor Request

```json
POST /fusewire
Content-Type: application/json

{
  "components": [
    {
      "fusewire-type": "component",
      "mode": "SERVER",
      "id": "Table#dashboard",
      "vars": { ... },
      "children": ["TableRow#0", "TableRow#1", "TableRow#2"]
    }
  ]
}
```

The `children` array lists the child component IDs the client currently holds for this component. The server uses this to determine which children are unchanged and can be sent as lightweight markers instead of full data (see [Unchanged Components](#unchanged-components)).

### Reactor Response

```json
{
  "fusewire-type": "response",
  "components": [
    {
      "fusewire-type": "component",
      "id": "Table#dashboard",
      "live": true,
      "vars": {
        "headers": ["Name", "Email", "Role"],
        "rows": [
          { "fusewire-type": "unchanged", "id": "TableRow#1" },
          { "fusewire-type": "component", "id": "TableRow#0",
            "vars": { "cells": ["Alice", "alice-new@example.com", "Manager"] } },
          { "fusewire-type": "component", "id": "TableRow#3",
            "vars": { "cells": ["Charlie", "charlie@example.com", "Viewer"] } }
        ]
      },
      "version": "a1b2c3d4e5f6"
    }
  ]
}
```

Each component in the response includes a `version` field -- the content hash of the component's template files. The client uses this to determine whether it needs to fetch (or re-fetch) the template via the [Template Endpoint](#template-endpoint). The `live` flag (present only when `true`) tells the client to subscribe for server-pushed updates when this component enters the DOM.

### Unchanged Components

When the server determines that a child component's data has not changed since the client last received it, it sends a lightweight marker instead of the full component data:

```json
{ "fusewire-type": "unchanged", "id": "TableRow#1" }
```

The client handles each child type as follows:

| Response type | Client already has it? | Action |
|---|---|---|
| `component` (full data) | No | Create new instance, render |
| `component` (full data) | Yes | Update vars, re-render |
| `unchanged` | Yes | Keep existing instance, no re-render |
| `deferred` | -- | Render from cache or default vars, fetch full data via separate Reactor request. See [Deferred Components](#deferred-components). |
| `error` | -- | Enter error state, trigger `onError` bubbling. See [Error Recovery](#error-recovery). |
| Absent (was in `children`, not in response) | Yes | Call `destroy()`, remove from DOM |

The **order** of the children array in the response defines display order. The DOM morpher handles reordering mount-point elements to match.

### Template Endpoint

Templates are served via a dedicated `GET` endpoint so they benefit from standard HTTP caching (browser cache, CDN, Service Worker).

#### URL Format

```
GET /fusewire/templates/:componentName/:version
```

- `:componentName` -- the component name (e.g. `Dashlet_ServerTime`).
- `:version` -- the expected content-hash version (e.g. `a1b2c3d4e5f6`).

The version is part of the URL path, so when a component's files change, the version (and therefore the URL) changes automatically. This makes every URL an **immutable snapshot** -- there is no need for ETags or conditional requests.

#### Response

```json
{
  "fusewire-type": "template",
  "id": "Dashlet_ServerTime",
  "jsUrl": "/js/components/Dashlet/ServerTime.js",
  "cssCode": ".servertime { color: green; }",
  "htmlCode": "((serverDateString))",
  "version": "a1b2c3d4e5f6"
}
```

The `jsUrl` points to a real ES module file served with `Content-Type: application/javascript`; the client loads it via `import(jsUrl)` instead of constructing a blob URL.

#### HTTP Caching Headers

```
Content-Type: application/json
Cache-Control: public, max-age=31536000, immutable
```

`immutable` tells browsers and CDNs that the response body will never change for this URL. Because the version is a content hash, a new deployment that changes a component's files produces a different version and therefore a different URL -- stale cache entries are never served.

#### Error Handling

| Status | Condition |
|--------|-----------|
| 200    | Component exists and the requested version matches the current version. |
| 404    | Component not found, or the requested version does not match (e.g. after a redeployment). The client should re-POST to the Reactor to get the updated version and retry. |

## Client Architecture

The client framework lives in `src/static/lib/fusewire/` and is served at `/js/fusewire/`. Key modules:

| Module         | Responsibility |
|----------------|---------------|
| `reactor.js`   | Orchestrator. Manages the react/fetch/render loop. Registers custom elements. Handles in-flight request deduplication. |
| `instance.js`  | Instance DAO. Tracks all live component instances, their vars, and versions. Handles create/update/remove/render. |
| `template.js`  | Template DAO. Caches templates via the Cache API (through a Service Worker). Fetches from server when missing or stale. |
| `component.js` | Base `Component` class. |
| `renderer.js`  | Template compilation and DOM morphing. Compiles HTML templates into render functions on first use. Applies vars to produce HTML, then morphs the DOM (via idiomorph). Manages CSS injection. |
| `server.js`    | HTTP communication. Sends component data requests to the Reactor endpoint and template requests to the template endpoint. |
| `config.js`    | Configuration object (server URL, client URL, tags, logging, etc.). |
| `error.js`     | Error hierarchy (`FuseWireError`, `ComponentNotFound`, `TemplateNotFound`, `ConfigMissing`, `ServerError`). |

### Custom Elements

The framework does not register any custom HTML elements. Child components are identified by the `data-fusewire-id` attribute on their root element (e.g. `<tr data-fusewire-id="TableRow#0">`). The framework tracks instances in the `instance.js` registry; the DOM morpher preserves mount points by matching `data-fusewire-id` values.

### Caching Strategy

#### Template and Module Caching

Template caching operates at two layers:

1. **HTTP cache (browser + CDN).** Because templates are served via `GET` with `Cache-Control: public, max-age=31536000, immutable` and the version is embedded in the URL, browsers and CDNs cache them indefinitely with no revalidation. This is the first cache layer hit on every request -- before JavaScript even runs.
2. **Service Worker / Cache API.** A Service Worker manages a second-level cache through the Cache API. This provides offline support, async access, and larger storage limits than `localStorage`.

Within the Service Worker cache:

- **Templates** (HTML + CSS) are stored keyed by component name. A version index allows quick version checks without deserializing every template.
- **JS modules** are cached as standard network responses. Because they are real files served with proper MIME types, the Service Worker can intercept `import()` fetches and serve them from cache on subsequent loads.

Templates and JS modules are immutable: the version (content hash) is part of the cache key. These entries are safe to share across tabs and never conflict.

#### Confirmed Vars

Component vars follow a CQRS-like model: the client sends current vars to the server (command), the server runs the component and returns new vars (query result). The server response is the **confirmed state** -- the authoritative, validated data for that component.

The framework tracks two layers of var state per component instance:

| Layer | Source | Storage | Lifetime |
|---|---|---|---|
| **Confirmed vars** | Last Reactor response | Service Worker cache, keyed by component ID | Persists across page loads, shared across tabs |
| **Local vars** | In-memory working state (starts as a copy of confirmed, modified by client) | Per-tab memory only | Lives for the duration of the instance |

When the client modifies vars locally (e.g. the user types in a search box) and calls `react('CSR')`, only local vars change. The confirmed vars and cache are untouched. When the client calls `react('SERVER')` and the server responds, the response overwrites both confirmed and local vars, and the cache is updated.

**Only confirmed vars are cached.** This means:

- The cache always holds server-validated data.
- Client-side dirty mutations (unconfirmed local changes) never enter the shared cache.
- Cross-tab cache reads always produce a known-good starting state.
- Stale-while-revalidate renders from the last server-confirmed state, not from another tab's speculative edits.

**CSR_ONLY components are not cached.** A CSR_ONLY component has no server interaction, so it never receives confirmed vars. Its initial vars come from the parent that created it (either from a server-side `run()` or from client-side code). When the parent is reconstructed from cache, the parent's confirmed vars include the CSR_ONLY child's initial data. There is no need for the child to cache independently.

**Opting out of caching.** Server-authoritative components can set `static cacheVars = false` to prevent their confirmed vars from being cached. This is appropriate for components with sensitive data that should not persist beyond the current session (e.g. financial data, personal information). These components always start with a full server fetch when recreated.

#### Mixed-Mode Component Trees

A component tree can mix rendering modes. How the server sees the tree depends on the context: SSR traverses the full tree, while Reactor requests and live pushes only see server-authoritative components.

```
Dashboard (SERVER, live)              ← server-authoritative, caches confirmed vars
  └── InteractiveChart (CSR_ONLY)     ← client-only, vars from parent
        └── ChartTooltip (CSR_ONLY)   ← client-only, created by Chart's client JS
              └── DetailPanel (SERVER) ← server-authoritative, independent from Dashboard
```

**SSR (full tree rendering).** SSR produces a complete HTML snapshot of the page -- the same output the client would render. The server traverses the full component tree, including through CSR_ONLY components:

1. Run Dashboard's `run()` → produces vars including InteractiveChart child.
2. Render InteractiveChart's template with initial vars from Dashboard. Execute its component logic to discover children (ChartTooltip, DetailPanel).
3. Render ChartTooltip's template with initial vars.
4. DetailPanel is server-authoritative → run its `run()` → render with server data.
5. Assemble the complete HTML and deliver to the browser.

This requires the SSR pass to execute the equivalent of client-side component logic on the server, so it can discover children that CSR_ONLY components create dynamically. This is the reason SSR support for mixed-mode trees is not trivial -- it needs to replicate what the client would do. But server-authoritative components nested inside CSR_ONLY parents are straightforward: the server can run their `run()` normally during the SSR pass.

The resulting complete HTML is useful for caching entire pages (e.g. home pages served from CDN) and for delivering instant first paint before any JS loads.

**Reactor requests and live pushes (server visibility boundary).** Outside of SSR, a CSR_ONLY component creates a visibility boundary for the Reactor. The server's Reactor does not know about the CSR_ONLY component's subtree because it only processes components with server-side `run()` methods that were created by other server-side `run()` methods:

- Dashboard's Reactor request lists `children: ["InteractiveChart#main"]`. The server has no knowledge of ChartTooltip or DetailPanel as Dashboard's descendants.
- DetailPanel makes its own independent Reactor requests. From the Reactor's perspective, it is a standalone top-level component.
- Live pushes for Dashboard cover InteractiveChart (Dashboard's known child) but not DetailPanel. DetailPanel subscribes independently for live pushes if it declares `static live = true`.

**Parent re-renders.** When Dashboard re-renders (from a push or Reactor response), InteractiveChart receives `update(oldVars)` with the new initial vars from Dashboard. InteractiveChart decides via `update()` what to accept and what to keep from its local state. Its own children (ChartTooltip, DetailPanel) are unaffected unless InteractiveChart's client logic explicitly recreates them.

**Reconstruction from cache.** Each server-authoritative component in the chain has its own cache entry. CSR_ONLY components in between are recreated by their parents:

1. Dashboard loads confirmed vars from cache → renders → creates InteractiveChart mount point.
2. InteractiveChart instantiated with initial vars from Dashboard's cached data → renders.
3. InteractiveChart's client logic creates ChartTooltip and DetailPanel.
4. DetailPanel loads its own confirmed vars from cache → renders (stale) → fetches from server.

#### Dirty State Persistence

By default, dirty state (local var modifications not yet confirmed by the server) lives only in per-tab memory. If the tab is closed or crashes, dirty state is lost. This is the same behavior as unsaved form data in any web application.

For components where losing dirty state is unacceptable (e.g. a text editor, a multi-step form), the framework provides an opt-in **dirty persistence** mechanism that uses tab-scoped storage (sessionStorage or IndexedDB with a tab identifier):

**Opt-in declaration:**

```js
export default class TextEditor extends Component {
  static persistDirty = true;   // persist dirty vars to tab-scoped storage
}
```

**The persistence flow:**

```
1. User modifies vars → local vars diverge from confirmed → component is dirty.
2. Framework debounces and writes dirty vars to tab-scoped storage,
   keyed by component ID + tab ID.
3. Tab crashes or is closed unexpectedly → dirty vars survive in storage.
4. Tab reopens → framework loads confirmed vars from SW cache,
   then checks tab-scoped storage for dirty vars → restores dirty state → renders.
5. Connection available → react('SERVER') → server confirms → confirmed vars cached,
   dirty storage entry cleared.
```

Dirty persistence is tab-scoped because the cache key (component ID) is shared with the server-confirmed version in the SW cache. Mixing dirty and confirmed data under the same key would be incoherent -- one tab's speculative edits could overwrite another tab's server-validated state. Tab-scoped storage keeps the two separate.

**Client-generated draft IDs.** When a component represents a new entity that has not been saved to the server yet (e.g. a new document, a new list item), it has no server-assigned ID. The framework provides a `generateDraftId()` helper that creates a UUID prefixed with `_draft-`:

```js
// Client-side: user clicks "New Document"
const id = Component.generateDraftId();  // '_draft-550e8400-e29b-...'
this.vars.editor = new TextEditor(id, { title: '', body: '' });
this.react('CSR');
```

Unlike dirty state on existing components, **draft entities are cached in the shared Service Worker cache**, not tab-scoped storage. This is safe because the UUID guarantees no collision -- there is no server-confirmed version under that key, no other component in any tab shares it. Caching drafts in the shared SW cache provides:

- **Cross-tab visibility.** A draft created in Tab A is available in Tab B. This matters for workflows where the user opens a new tab to reference something while creating content.
- **Instance cleanup recovery.** A draft that is cleaned up (component leaves the DOM) can be reconstructed from the SW cache like any server-authoritative component.
- **Stale-while-revalidate.** When the draft's component re-enters the DOM, it renders immediately from cache.

When the server eventually processes the draft (on save or reconnect), the server can accept the draft ID as the permanent ID or return a different one. If the server returns a different ID, the framework handles the transition: it updates the instance registry, removes the old cache entry, creates a new one under the server-assigned ID, and updates the DOM attribute.

The `_draft-` prefix is a convention, not enforced. It lets developers and debugging tools distinguish client-created entities from server-assigned ones.

**Interaction with disconnected state.** When a component is dirty and the connection is down (`fusewire-disconnected` CSS class on the document body), the two mechanisms complement each other:

- **Existing components** (server-assigned ID): dirty persistence in tab-scoped storage provides crash recovery. Confirmed vars in the SW cache provide the fallback render state.
- **Draft entities** (client-generated UUID): vars cached in the shared SW cache. Survive tab crashes, visible across tabs, recoverable after instance cleanup.

In both cases:

- Tab stays open, no connection: user keeps working, local renders via `react('CSR')`. No data loss.
- Tab crashes: state recovered from the appropriate store on reopen.
- Connection returns: `react('SERVER')` syncs with the server. On success, confirmed vars updated (or created for drafts), dirty storage cleared.
- Tab closed normally: the `beforeunload` handler clears tab-scoped dirty storage (the user chose to leave). Draft entities in the SW cache persist -- they are not tab-scoped. Components can override the tab-scoped cleanup by setting `static persistDirty = 'keep'` to retain dirty state across intentional tab closes (e.g. for form recovery on next visit).

### First-Load Performance

On the first page load -- before the Service Worker cache is populated -- the client may need to fetch many small JS module files (one per component in the tree). SSR is the primary mitigation: the server sends fully rendered HTML so the user sees content immediately without waiting for any JS. Components then hydrate progressively in the background as their modules arrive, becoming interactive one by one.

Additional techniques speed up the hydration phase:

- **Loading indicator.** The initial HTML can include a lightweight loading screen (or per-component placeholders) that is displayed until hydration completes. On the very first visit this may be visible briefly while JS modules are fetched; on subsequent loads the Service Worker cache makes it near-instant.
- **Parallel imports.** Template responses include `jsUrl` for each component. The client fires all `import()` calls concurrently rather than waiting for each component to render before importing the next.
- **HTTP/2 multiplexing.** All module requests go to the same origin over a single connection, so the many-small-files overhead is largely eliminated at the transport level.
- **`modulepreload` hints.** For the initial HTML page, the server can inject `<link rel="modulepreload">` tags for the known root component tree, telling the browser to start fetching modules before any JS executes.
- **Service Worker precaching.** On install, the Service Worker can precache critical component modules so they are available immediately on the first navigation after registration.

After the first load, all JS modules and templates are served from the Service Worker cache, making subsequent navigations fast regardless of component count.

### Instance Cleanup

In a long-lived SPA, components enter and leave the DOM as the user navigates. The `instance.js` registry tracks all live instances in memory. Without cleanup, this map grows indefinitely -- a memory leak.

#### Orphan Detection

The primary cleanup mechanism is the normal component lifecycle: when a parent re-renders and a child is absent from the server response, the framework calls `destroy()` and removes the instance from the registry (see [Unchanged Components](#unchanged-components)). This handles the common case.

As a safety net, the registry runs a **periodic sweep** that checks whether each tracked instance still has a corresponding DOM element (matched by `data-fusewire-id`). Instances whose mount points are no longer in the document are orphans -- their `destroy()` hook is called and they are removed from the registry.

The sweep runs on a configurable interval (default: 60 s) and after root component transitions. An **instance cap** (default: 500) provides a hard limit: when the cap is reached, the registry evicts least-recently-rendered instances that are no longer in the DOM.

#### Why Cleanup Is Safe: State Persistence

Cleanup does not mean data loss. Confirmed vars are persisted in the Service Worker cache keyed by component ID (see [Confirmed Vars](#confirmed-vars)). When a previously-seen server-authoritative component re-enters the DOM, the framework restores its confirmed vars from cache and renders immediately, then refreshes from the server. The cost of recreating a cleaned-up component is a single cache read, not a full server round trip.

CSR_ONLY components do not cache independently -- their vars come from the parent. When the parent is recreated from cache, it provides the CSR_ONLY child's initial vars.

Components that set `static cacheVars = false` do not persist their confirmed vars. When these components are cleaned up and later re-enter the DOM, they start fresh with a full server fetch.

#### Cache-Aware Rendering (Stale-While-Revalidate)

When confirmed vars exist in cache for a component being created, the framework renders immediately from cache and fetches fresh data from the server in parallel. This is a natural extension of `SERVER` mode's optimistic UI pattern:

1. Component created with confirmed vars from cache -> `hydrate()` called -> render.
2. `fusewire-refreshing` CSS class added to the container.
3. Server responds with fresh data -> confirmed vars and local vars updated -> cache updated -> `update(oldVars)` called -> re-render.
4. `fusewire-refreshing` CSS class removed.

If the server fetch fails, the error recovery flow applies normally (see [Error Recovery](#error-recovery)). The cached render is kept -- the user sees stale data with an error indicator rather than nothing.

`SERVER_WAIT` mode does **not** use cached vars. By choosing `SERVER_WAIT`, the developer has explicitly opted for blocking server data over fast feedback. `CSR_ONLY` components have no confirmed vars to cache, so cache-aware rendering does not apply to them.

Developers can detect the refreshing state via the CSS class and style accordingly (e.g. a subtle progress indicator, reduced opacity). The pattern mirrors the error recovery model: a CSS class signals the state, existing lifecycle hooks (`hydrate`, `update`) handle the transitions, and the framework provides sensible defaults without requiring component-level code.

## Server Architecture (FuseWire-JS)

### Request Flow

```
Browser
  |
  |-- GET /js/fusewire/*          -->  express.static  -->  src/static/lib/fusewire/
  |                                     (client framework modules)
  |
  |-- GET /js/components/*        -->  express.static  -->  src/components/
  |                                     (component client files: .js, .html, .css)
  |                                     (*.server.js excluded)
  |
  |-- GET /fusewire/templates/*   -->  Template handler  -->  JSON (immutable, HTTP-cached)
  |
  |-- POST /fusewire              -->  Reactor  -->  JSON response
  |
  |-- GET /                       -->  Express router  -->  application routes
```

### Reactor (server-side)

The Reactor is the server-side entry point. On each request it:

1. Parses the `components` array from the JSON request body.
2. For each component request:
   - Instantiates the component class, injects client vars.
   - Calls `run()` -- the component populates its server-side data (may create child components).
   - Compares the resulting children against the client's `children` array to determine which are unchanged.
   - Computes the template version from a content hash of the component's files (see [Versioning](#versioning)).
   - Serializes the component tree into a `ComponentResponse`, using `unchanged` markers where possible.
3. Returns the JSON response.

Templates are **not** served by the Reactor. They are handled by the separate [Template Endpoint](#template-endpoint), which reads the `.html` and `.css` files, resolves the `.js` module URL, and returns the template with immutable HTTP caching headers.

### Component Definition (server-side)

Server-side components are classes that:
- Extend a base `Component` class.
- Declare public properties as their "vars" (the data contract with the client).
- Implement `run()` to populate those vars with server-side logic.
- Can nest child components by assigning Component instances to their vars.
- Optionally set `static live = true` to enable server-pushed updates (see [Event-Driven Refresh](#event-driven-refresh)).

```js
export default class Table extends Component {
  static live = true;   // this component receives server-pushed updates

  headers = [];
  rows = [];

  run() {
    this.headers = ['Name', 'Email', 'Role'];
    this.rows = [
      new TableRow('0', { cells: ['Alice', 'alice@example.com', 'Admin'] }),
      new TableRow('1', { cells: ['Bob', 'bob@example.com', 'Editor'] }),
    ];
  }
}
```

### Deferred Components

When a component tree is large or some children are expensive to compute, the server can return completed children immediately and mark the rest as `deferred` for later fetching. The client renders what it has (from cache or default vars), then progressively fills in deferred children via separate Reactor requests.

Components can declare `static slow = true` as a hint that affects server execution order (slow children run last) and client request batching (slow and non-slow deferred children are fetched in separate requests so that fast ones are not blocked by slow ones).

See [docs/deferred-components.md](deferred-components.md) for the protocol marker, server time-budget model, client batching strategy, and interaction with other features.

### Event-Driven Refresh

Components can receive server-pushed updates over a persistent connection (WebSocket or SSE) by declaring `static live = true` on the server class. Live components subscribe when they enter the DOM and unsubscribe when removed. A parent-covers-children rule keeps subscription counts low: if a parent is live, its children are covered by the parent's subscription.

The server maintains a lightweight subscription registry mapping connections to their displayed live components. When data changes, the server runs the affected component, computes `unchanged` markers using the registry's child list, and pushes a Reactor-format response over the persistent connection.

See [docs/event-driven-refresh.md](event-driven-refresh.md) for subscription rules, push flow, and subscription limits.

## Multi-Tab Behavior

FuseWire does not synchronize state across concurrent browser tabs. This is a deliberate design choice, not an oversight. The confirmed-vars caching model (see [Confirmed Vars](#confirmed-vars)) makes cross-tab conflicts benign by construction.

### Per-Tab vs. Shared State

| State | Scope | Conflict possible? |
|---|---|---|
| Instance registry (live component map) | Per-tab (in-memory) | No |
| Local vars (dirty mutations) | Per-tab (in-memory) | No |
| Dirty persistence store | Per-tab (sessionStorage / IndexedDB with tab ID) | No |
| Compiled template functions | Per-tab (in-memory) | No |
| DOM tree | Per-tab | No |
| WebSocket / SSE connection | Per-tab | No -- server tracks subscriptions per connection |
| Service Worker Cache API (templates, JS modules) | Shared (same origin) | No -- immutable, version-keyed entries |
| Service Worker Cache API (confirmed vars) | Shared (same origin) | Yes -- last write wins |

The only shared mutable state is the confirmed-vars cache. Because only server-confirmed data enters this cache (never client-side dirty mutations), cross-tab stomping produces the same class of brief staleness that stale-while-revalidate already handles: one tab may briefly see another tab's confirmed data, but the server response corrects it within the same render cycle.

### Why No Coordination

Adding cross-tab coordination (locking, `BroadcastChannel`, tab-scoped cache keys) was considered and rejected:

| Approach | Cost | Benefit |
|---|---|---|
| `BroadcastChannel` notifications | Moderate complexity; every cache write broadcasts, every tab listens and potentially re-renders | Other tabs see fresh data slightly sooner (milliseconds before their own server response would arrive anyway) |
| Tab-scoped cache keys | Duplicates cached data per tab; breaks the shared-cache efficiency that makes instance cleanup cheap | Prevents cross-tab staleness for the brief stale-while-revalidate window |
| Locking (Web Locks API) | Serializes cache writes across tabs; adds latency to every cache operation | Prevents torn reads during concurrent writes -- a scenario that produces at worst a stale render that the server corrects |

In all cases the benefit is marginal: the server response arrives within milliseconds and overwrites the stale render. The cost is permanent complexity in the caching layer. FuseWire's position is that the simpler last-write-wins model is the right trade-off.

### Service Worker Lifecycle

When a new Service Worker version activates (e.g. after a deployment), it takes control of all tabs on the same origin. This is standard Service Worker behavior. Effects on FuseWire:

- **Cache version migration.** If the new SW changes the cache schema or eviction policy, all tabs are affected simultaneously. The SW install/activate hooks should handle migration before claiming clients.
- **No per-tab impact.** Because the cache is an optimization layer, a SW activation that clears the cache simply causes all tabs to fetch fresh data from the server on their next render cycle. There is no data loss -- the server holds the truth.

### Live Connections

Each tab opens its own WebSocket or SSE connection. The server's subscription registry maps connections to live components independently. Tab A's subscriptions do not interfere with Tab B's. When a tab is closed, its connection drops and the server clears its subscriptions.

### Guidance for Developers

- **Do not rely on the client cache for correctness.** The cache is a performance optimization. Any data that must be consistent across tabs should be enforced server-side (in `run()`).
- **`cacheVars = false` for sensitive data.** Components that set `static cacheVars = false` prevent their confirmed vars from being cached. This is appropriate for data that should not persist beyond the session (e.g. financial data, personal information).
- **Tab-specific state stays in memory.** Unsaved form input, scroll position, modal open/close -- these live in the component's local vars (per-tab memory). They never enter the shared cache. For crash recovery of local state, use `static persistDirty = true` (see [Dirty State Persistence](#dirty-state-persistence)).

## Error Recovery

FuseWire handles errors at the component level, not the request level. A failure in one component does not break its siblings or parent. The Reactor catches `run()` exceptions and serializes them as per-component error markers (`fusewire-type: "error"`) alongside successful results. The HTTP status remains 200; individual failures are expressed in the JSON body.

On the client, errors follow a bubbling model: `onError(error)` is called on the failed component, and if unhandled, bubbles to the parent. A default error placeholder with a retry button is shown when no component handles the error. Retryable errors (network failures, timeouts) use exponential backoff; non-retryable errors (syntax errors, 404s) are surfaced immediately.

The framework defines standard error codes (`RUN_FAILED`, `TIMEOUT`, `NOT_FOUND`, `NETWORK_ERROR`, `TEMPLATE_FETCH_FAILED`, `MODULE_LOAD_FAILED`, `RENDER_FAILED`) and CSS classes (`fusewire-error`, `fusewire-retrying`, `fusewire-disconnected`) for styling error and recovery states.

See [docs/error-handling.md](error-handling.md) for the full error recovery model.

## Navigation

FuseWire provides URL-based navigation without a centralized router. Each component optionally declares a **route state** -- a minimal key/value object that defines its current "location" -- and the framework composes these into a URL. The URL can be decomposed back to reconstruct the component tree.

URLs use a compact nested syntax: `/Users(search=alice,Detail::123(tab=activity))`. Components declare short aliases (`static routeName`) that are unique among siblings, keeping URLs readable. The `::` separator encodes instance IDs.

On reconstruction (back button, shared link), the framework applies route state top-down: it creates the root component with the route state as vars, lets it `run()` normally, then searches the resulting children for the next route segment and recurses. Components that no longer exist (stale data, permission changes) are silently skipped.

Server-stored short URLs are available as an opt-in feature with a pluggable storage backend. Inline URLs are the default.

See [docs/navigation.md](navigation.md) for the full navigation model.
