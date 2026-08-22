# Agent Note: llm-pi-ai route overlays the provider's live model listing

Status: implemented

[English](2026-08-22-llm-pi-ai-live-model-catalog.md) | 中文

## Problem

Web 聊天里的模型选择器读取 `ctx.llm.listModels(provider)`，而 pi-ai 路由此前返回的是随构建打包的 catalog（或 `settings.yaml` 显式列出的内容）。提供方新增、改名或下架模型——例如 OpenCode Zen 的 `opencode-go`——列表就会一直陈旧，直到 pi-ai 升级或手动编辑 settings，而且没有任何办法从端点刷新。

## Decision

新的按路由 profile 字段 `refreshCatalog: true` 会让该路由公布的 catalog 在每次发现读取时叠加其端点 OpenAI 兼容的 `GET /models` 列表。`ctx.llm.listModels` 由 Web 选择器和 ACP 编辑器在打开时读取，因此每次打开都反映提供方当前阵容，客户端无需改动。

机制：`resolveProfiles` 用 `listingBaseFor` 从路由 `baseURL` 推导列表来源，否则取首个 OpenAI 兼容基线模型的 `baseUrl`，两者皆无的路由会被拒绝。提供方以动态方式构造（`createProvider({ fetchModels })`），pi-ai 在同一份 `Models` 集合里把实时叠加合并到基线之上，新列出的 id 因此可直接服务——`getModel`／流式派发都看得到它，在选择器里选中新 id 不会以 `UNKNOWN_MODEL` 失败。适配器的 `listModels` 在读取集合之前，用 harness 解析的凭据和一个内存态存储触发 `piProvider.refreshModels`；失败的列表会被吞掉，静态基线继续服务，并通过 `onCatalogRefreshError` 钩子上报（日志记作 `serving the static catalog`）。

叠加语义：端点仍在广播的已安装 id 保留其既有元数据（上下文窗口、compat、推理能力）；只有端点知道的 id 变成继承该路由 OpenAI 模板（协议、端点、compat、推理能力）的裸 descriptor；端点不再广播的已安装 id 会被丢弃。当非空显式 `models` 列表在手工维护路由阵容时，`refreshCatalog` 不生效。

## Alternatives considered

**让每条 OpenAI 兼容路由都始终刷新。** 否决：官方端点的列表不含容量或 compat，而且在每次打开选择器时为每个提供方引入网络读取，会惊到从没要求过它的部署。按路由加入让共享逻辑保留，同时把行为变得显式。

**只刷新 `opencode-go`。** 否决：机制与提供方无关（任何列表来源可推导的路由都适用），一个共享的可选项既能覆盖所请求的提供方，也能覆盖所有类似的网关。

**只把实时列表给选择器，却不让它可服务。** 否决：选择器列出流式路径会以 `UNKNOWN_MODEL` 拒绝的模型，是个陷阱。用 pi-ai 的动态提供方机制让列出与派发共用同一个事实来源。

**把拉取到的叠加持久化到磁盘并设 TTL。** 否决：刷新是每次打开、进程内进行，因此没有落盘陈旧叠加层，也没有需要配置的保鲜窗口——少一个随部署变化的旋钮。

## Consequences

`refreshCatalog` 路由的选择器在每次打开时反映提供方当前阵容，包括从未进入已安装 catalog 的模型，而已知模型保留更丰富的元数据。代价是仅对该路由每次打开选择器多一次网络 `GET /models`，端点临时宕机时降级为静态 catalog（记入日志）而不是清空选择器。未设置该字段的路由逐字节不变。列表来源无法推导的路由在解析时明确失败，而不是静默保留陈旧列表。

## Testing

`tests/refresh-catalog.spec.ts` 覆盖 `listingBaseFor` 推导、在真实 `GET /models` 服务器上的叠加（已知 id 元数据保留、新 id 加入）、新列出的 id 可通过 `resolveModel` 解析、带刷新错误钩子的降级回退、动态重建后全部已安装协议保留，以及显式 `models` 时的无操作行为。