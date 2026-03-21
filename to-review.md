
Unsolved problems the architecture doesn't address


1.  Server-side component execution is unbounded. run() can do anything -- database queries, HTTP calls, file I/O. There's no timeout, no resource
limit, and no sandboxing. A single slow component blocks the entire response. The deferred rendering feature is the answer to this, but without it, one
bad component can take down the whole page.
