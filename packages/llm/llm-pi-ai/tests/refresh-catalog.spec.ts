import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { listingBaseFor } from '../src/catalog.ts'

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

/** A stand-in provider answering one scripted `GET /v1/models`. */
async function listingServer(body: string): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths }
}

/** Direct adapter over the real profile resolver; records refresh failures. */
function adapterOf(
  providers: Record<string, LlmPiAi.PiAiProviderProfile>,
  options: { apiKey?: string | undefined; onRefreshError?: (detail: { provider: string; error: unknown }) => void } = {},
): PiAiAdapter {
  // Memoize like production: a stable profiles identity lets the adapter keep
  // one snapshot, so a refresh triggered by `listModels` persists into a later
  // `resolveModel` on the same provider object.
  let cached: ReturnType<typeof resolveProfiles> | undefined
  return new PiAiAdapter({
    profiles: () => (cached ??= resolveProfiles(providers)),
    resolveApiKey: () => Promise.resolve(options.apiKey),
    ...options.onRefreshError === undefined ? {} : { onCatalogRefreshError: options.onRefreshError },
  })
}

describe('listingBaseFor', () => {
  it('returns the route baseURL when set, preferring it over a model baseUrl', () => {
    const model = { id: 'm', api: 'openai-completions', baseUrl: 'https://other/v1', provider: 'p' } as never
    expect(listingBaseFor(new Map([['m', model]]), 'https://route/v1')).toBe('https://route/v1')
  })

  it('falls back to an OpenAI-compatible model baseUrl when no route baseURL', () => {
    const openai = { id: 'm', api: 'openai-completions', baseUrl: 'https://models/v1', provider: 'p' } as never
    const anthropic = { id: 'a', api: 'anthropic-messages', baseUrl: 'https://models/v1/anthropic', provider: 'p' } as never
    expect(listingBaseFor(new Map([['a', anthropic], ['m', openai]]))).toBe('https://models/v1')
  })

  it('returns undefined when nothing OpenAI-compatible can be derived', () => {
    const anthropic = { id: 'a', api: 'anthropic-messages', baseUrl: 'https://models/v1/anthropic', provider: 'p' } as never
    expect(listingBaseFor(new Map([['a', anthropic]]))).toBeUndefined()
  })
})

describe('refreshCatalog live overlay', () => {
  it('overlays the endpoint listing over the static catalog on listModels', async () => {
    const server = await listingServer(JSON.stringify({
      data: [
        { id: 'deepseek-v4-flash', name: 'Renamed By Endpoint' },
        // A duplicate id is ignored rather than listed twice.
        { id: 'deepseek-v4-flash', name: 'Duplicate' },
        { id: 'new-model', name: 'Brand New' },
      ],
    }))
    const adapter = adapterOf({
      'opencode-go': { baseURL: `${server.url}/v1`, refreshCatalog: true },
    }, { apiKey: 'probe-key' })
    const models = await adapter.listModels('opencode-go')
    const ids = models.map(model => model.id)
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('new-model')
    // The duplicate did not produce a second deepseek-v4-flash row.
    expect(ids.filter(id => id === 'deepseek-v4-flash')).toHaveLength(1)
    // Known model keeps its authored metadata, not the listing's loose name.
    const known = models.find(model => model.id === 'deepseek-v4-flash')!
    expect(known.name).toBe('DeepSeek V4 Flash')
    expect(known.inputModalities).toEqual(['text'])
    // The listing was fetched from the derived endpoint.
    expect(server.paths).toEqual(['/v1/models'])
  })

  it('makes a freshly advertised model servable, not just listed', async () => {
    const server = await listingServer(JSON.stringify({ data: [{ id: 'new-model', name: 'Brand New' }] }))
    const adapter = adapterOf({
      'opencode-go': { baseURL: `${server.url}/v1`, refreshCatalog: true },
    })
    await adapter.listModels('opencode-go')
    // A model absent from the static catalog must still resolve (no UNKNOWN_MODEL).
    const resolved = await adapter.resolveModel('opencode-go', 'new-model')
    expect(resolved.id).toBe('new-model')
    expect(resolved.provider).toBe('opencode-go')
  })

  it('falls back to the static catalog and reports when the live listing fails', async () => {
    const errors: { provider: string; error: unknown }[] = []
    const adapter = adapterOf({
      'opencode-go': { baseURL: 'http://127.0.0.1:1/v1', refreshCatalog: true },
    }, { onRefreshError: detail => errors.push(detail) })
    // A dead endpoint must not drop the route from the selector.
    const models = await adapter.listModels('opencode-go')
    expect(models.map(model => model.id)).toContain('deepseek-v4-flash')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.provider).toBe('opencode-go')
  })

  it('keeps every installed protocol while adding a live model', async () => {
    const server = await listingServer(JSON.stringify({ data: [{ id: 'new-model' }] }))
    const adapter = adapterOf({
      'opencode-go': { baseURL: `${server.url}/v1`, refreshCatalog: true },
    })
    const ids = (await adapter.listModels('opencode-go')).map(model => model.id)
    // Anthropic, OpenAI-completions, and OpenAI-responses models all survive;
    // the live overlay is layered over, not a replacement of, the catalog.
    expect(ids).toContain('minimax-m3')
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('grok-4.5')
    expect(ids).toContain('new-model')
  })

  it('builds a dynamic provider over an explicit api override', async () => {
    const server = await listingServer(JSON.stringify({ data: [{ id: 'new-model' }] }))
    const adapter = adapterOf({
      'opencode-go': {
        api: 'openai-completions',
        baseURL: `${server.url}/v1`,
        refreshCatalog: true,
      },
    })
    const models = await adapter.listModels('opencode-go')
    expect(models.map(model => model.id)).toContain('new-model')
    expect(server.paths).toEqual(['/v1/models'])
  })

  it('warns through the plugin hook when a live refresh fails', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(LlmPiAi, {
      providers: { 'opencode-go': { baseURL: 'http://127.0.0.1:1/v1', refreshCatalog: true } },
    })
    await expect(ctx.llm.listModels('opencode-go')).resolves.not.toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('live model listing for route "opencode-go" failed'))
  })

  it('ignores refreshCatalog when an explicit models list curates the route', async () => {
    const adapter = adapterOf({
      gw: {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:1/v1',
        refreshCatalog: true,
        models: [{ id: 'curated-model', contextWindow: 4096, maxTokens: 512 }],
      },
    })
    // No network attempt: the explicit list is authoritative and unchanged.
    const models = await adapter.listModels('gw')
    expect(models).toEqual([{ provider: 'gw', id: 'curated-model', name: 'curated-model', inputModalities: ['text'] }])
  })

  it('refuses a refreshCatalog route with no derivable listing origin at load', () => {
    // `anthropic` is a catalog route whose installed models all speak
    // anthropic-messages; no baseURL is set, so nothing OpenAI-compatible can
    // be derived and resolution must fail loud rather than keep a stale list.
    expect(() => resolveProfiles({ anthropic: { refreshCatalog: true } }))
      .toThrow(/no OpenAI-compatible listing endpoint can be derived/)
  })

  it('refuses a refreshCatalog route naming an unsupported api', () => {
    expect(() => resolveProfiles({
      'opencode-go': { api: 'bogus', baseURL: 'http://example.test/v1', refreshCatalog: true },
    })).toThrow(/names api "bogus"/)
  })

  it('falls back to the static catalog when the credential cannot be resolved', async () => {
    const errors: { provider: string; error: unknown }[] = []
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ 'opencode-go': { refreshCatalog: true } }),
      resolveApiKey: () => Promise.reject(new Error('key missing')),
      onCatalogRefreshError: detail => errors.push(detail),
    })
    const models = await adapter.listModels('opencode-go')
    expect(models.map(model => model.id)).toContain('deepseek-v4-flash')
    expect(errors).toHaveLength(1)
  })
})
