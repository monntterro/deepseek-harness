# Agent Note: llm-pi-ai route overlays the provider's live model listing

Status: implemented

English | [中文](2026-08-22-llm-pi-ai-live-model-catalog.zh.md)

## Problem

The model selector in the Web chat reads `ctx.llm.listModels(provider)`, which for a pi-ai route returned the catalog bundled at build time (or whatever `settings.yaml` explicitly lists). A provider that adds, renames, or retires models — OpenCode Zen's `opencode-go`, for one — stayed stale until a pi-ai upgrade or a manual settings edit, and there was no way to refresh it from the endpoint.

## Decision

A new per-route profile field `refreshCatalog: true` makes the route's advertised catalog overlay its endpoint's OpenAI-compatible `GET /models` listing on every discovery read. `ctx.llm.listModels` is read by the Web picker and the ACP editors on open, so each open reflects the provider's current lineup with no client change.

Mechanism: `resolveProfiles` derives the listing origin (`listingBaseFor`) from the route `baseURL`, else from the first OpenAI-compatible baseline model's `baseUrl`, and refuses a route where neither exists. The provider is built dynamic (`createProvider({ fetchModels })`), so pi-ai merges the live overlay over the baseline in one `Models` collection and a freshly listed id is servable — `getModel`/stream dispatch see it, so selecting a new id in the picker does not fail `UNKNOWN_MODEL`. The adapter's `listModels` triggers `piProvider.refreshModels` with the harness-resolved credential and an in-memory store before reading the collection; a failed listing is swallowed and the static baseline keeps serving, reported through the `onCatalogRefreshError` hook (logged as `serving the static catalog`).

Overlay semantics: an installed id the endpoint still advertises keeps its authored metadata (context window, compat, reasoning); an id only the endpoint knows becomes a bare descriptor inheriting the route's OpenAI template (protocol, endpoint, compat, reasoning); an installed id the endpoint no longer advertises is dropped. `refreshCatalog` is ignored when a non-empty explicit `models` list curates the route.

## Alternatives considered

**Always refresh every OpenAI-compatible route.** Rejected: official endpoints' listings carry no capacities or compat, and adding a network read on every picker open to every provider would surprise deployments that never asked for it. The per-route opt-in keeps the shared logic but makes the behavior explicit.

**Refresh only `opencode-go`.** Rejected: the mechanism is provider-agnostic (any route whose listing origin is derivable), so one shared opt-in covers the requested provider and every gateway like it.

**Serve the live listing to the selector without making it servable.** Rejected: a picker that lists a model the stream path rejects with `UNKNOWN_MODEL` is a trap. Using pi-ai's dynamic-provider machinery keeps listing and dispatch one source of truth.

**Persist the fetched overlay to disk with a TTL.** Rejected: the refresh is per open and process-local, so there is no stale on-disk overlay and no freshness window to configure — one less deployment-varying tunable.

## Consequences

A `refreshCatalog` route's selector reflects the provider's current lineup on each open, including models never in the installed catalog, while known models keep their richer metadata. The cost is a network `GET /models` per picker open for that route only, and a transient endpoint outage degrades to the static catalog (logged) rather than emptying the selector. Routes without the field are byte-for-byte unchanged. A route whose listing origin cannot be derived fails loud at resolution rather than silently keeping a stale list.

## Testing

`tests/refresh-catalog.spec.ts` covers `listingBaseFor` derivation, overlay on a real `GET /models` server (known-id metadata preserved, new id added), a freshly advertised id resolving through `resolveModel`, fail-soft fallback with the refresh-error hook firing, all installed protocols surviving the dynamic rebuild, and the explicit-`models` no-op.