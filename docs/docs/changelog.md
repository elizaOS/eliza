# Changelog

## v0.25.9 (March 02, 2025)

#### v0.25.9 Release Notes

#### Features

- CLI install improvements #3697
- Checking the plugin is installed and display the result #3660
- Add post-processing support for character loading #3686
- Submit update env for plugin viction #3701
- ANTHROPIC_API_URL env #3711

#### Fixes

- Fix Out Of Memory bug introduced in 0.25.8 #3722
- Fix splitText #3653
- Add database adapter and plugin adapter types to core types #3640
- Fix CLI install #3673
- CLI - escape paths with spaces correctly #3699
- CLI handle plugin dependencies / trusdb #3737
- Handle short text items in knowledge processing #3652
- Character knowledge add directory #3678
- Grammar fix & createVerifiableLogApiRouter guard #3707

#### What's Changed

* docs: Fix plugins.md formatting by @Doge-is-Dope in https://github.com/elizaOS/eliza/pull/3649
* fix: Add database adapter and plugin adapter types to core types by @Luks3110 in https://github.com/elizaOS/eliza/pull/3640
* fix: Handle short text items in knowledge processing by @boolkeys in https://github.com/elizaOS/eliza/pull/3652
* docs: Update README_KOR.md by @cryptokatze in https://github.com/elizaOS/eliza/pull/3670
* feat: checking the plugin is installed and display the result by @v1xingyue in https://github.com/elizaOS/eliza/pull/3660
* Fix Typographical Errors in Documentation by @leopardracer in https://github.com/elizaOS/eliza/pull/3656
* fix: fix CLI install by @odilitime in https://github.com/elizaOS/eliza/pull/3673
* chore: Update docs, adds changelog notes, merges pages, cleanup by @madjin in https://github.com/elizaOS/eliza/pull/3694
* fix: character knowledge add directory by @hkhangus in https://github.com/elizaOS/eliza/pull/3678
* feat: Add post-processing support for character loading by @btspoony in https://github.com/elizaOS/eliza/pull/3686
* docs: fix broken links in README by @Dahka2321 in https://github.com/elizaOS/eliza/pull/3684
* feat: CLI install improvements by @odilitime in https://github.com/elizaOS/eliza/pull/3697
* feat: better plugin loading error handling / json5 support for character file by @odilitime in https://github.com/elizaOS/eliza/pull/3698
* fix: CLI - escape paths with spaces correctly by @odilitime in https://github.com/elizaOS/eliza/pull/3699
* feat: submit update env for plugin viction by @khiemsoft in https://github.com/elizaOS/eliza/pull/3701
* feat: ANTHROPIC_API_URL env. by @ChristopherTrimboli in https://github.com/elizaOS/eliza/pull/3711
* chore: security NPM updates / bump turbo by @odilitime in https://github.com/elizaOS/eliza/pull/3700
* fix: clean up `pnpm clean` output and make `pnpm dev` faster on faster CPUs by @odilitime in https://github.com/elizaOS/eliza/pull/3714
* chore: format pass by @odilitime in https://github.com/elizaOS/eliza/pull/3715
* chore: tests favor local paths for consistency / adjust deps by @odilitime in https://github.com/elizaOS/eliza/pull/3716
* fix: fix 0.25.8 oom bug by @v1xingyue in https://github.com/elizaOS/eliza/pull/3722
* chore: Update docs, add blog + showcase + changelog + RSS by @madjin in https://github.com/elizaOS/eliza/pull/3729
* fix: Grammar fix & createVerifiableLogApiRouter guard by @Hopium21 in https://github.com/elizaOS/eliza/pull/3707
* fix: Fix splitText by @batudo in https://github.com/elizaOS/eliza/pull/3653
* docs: update readme.md for the custom plugins how-to by @Xayaan in https://github.com/elizaOS/eliza/pull/3736
* fix: CLI handle plugin dependencies / trusdb by @odilitime in https://github.com/elizaOS/eliza/pull/3737
* chore: bump ver to 0.25.9 by @odilitime in https://github.com/elizaOS/eliza/pull/3738
* chore: dev =>  main (rel 0.25.9 prep) by @odilitime in https://github.com/elizaOS/eliza/pull/3739

#### New Contributors

<details>
<summary>View New Contributors</summary>
* @Doge-is-Dope made their first contribution in https://github.com/elizaOS/eliza/pull/3649
* @Luks3110 made their first contribution in https://github.com/elizaOS/eliza/pull/3640
* @boolkeys made their first contribution in https://github.com/elizaOS/eliza/pull/3652
* @cryptokatze made their first contribution in https://github.com/elizaOS/eliza/pull/3670
* @hkhangus made their first contribution in https://github.com/elizaOS/eliza/pull/3678
* @khiemsoft made their first contribution in https://github.com/elizaOS/eliza/pull/3701
</details>

#### Full Changelog: https://github.com/elizaOS/eliza/compare/v0.25.8...v0.25.9

---

## v0.25.8 (February 24, 2025)

#### Major changes since [v0.25.6-alpha.1]()

#### Features

- Dynamic plugin loading (move all plugins out) https://github.com/elizaOS/eliza/pull/3339
- plugin CLI list/installer utility https://github.com/elizaOS/eliza/pull/3429
- Enable fetching relevant facts in the facts provider https://github.com/elizaOS/eliza/pull/2635
- Gaianet support set API key https://github.com/elizaOS/eliza/pull/3591
- Add NEAR AI model provider https://github.com/elizaOS/eliza/pull/3275
- Support for Secret AI LLM https://github.com/elizaOS/eliza/pull/3615
- Added cachedir to filesystem cache https://github.com/elizaOS/eliza/pull/3291
- Configuration: set Lava as the default RPC URL for NEAR and Starknet https://github.com/elizaOS/eliza/pull/3323
- Modify the configuration for the plugin-nkn https://github.com/elizaOS/eliza/pull/3570

#### Fixes

- https://github.com/advisories/GHSA-584q-6j8j-r5pm https://github.com/elizaOS/eliza/pull/2958
- Fix default character https://github.com/elizaOS/eliza/pull/3345
- Fix set agent from API https://github.com/elizaOS/eliza/pull/3618
- Store stringKnowledge in knowledge when ragKnowledge is enabled (https://github.com/elizaOS/eliza/issues/3434) https://github.com/elizaOS/eliza/pull/3435
- Update chunk & overlap in rag function https://github.com/elizaOS/eliza/pull/2525
- Fix bedrock inference https://github.com/elizaOS/eliza/pull/3553
- Generate structured objects and images with NEAR AI https://github.com/elizaOS/eliza/pull/3644
- Exporting structured objects and images with NEAR AI https://github.com/elizaOS/eliza/pull/3644

#### What's Changed since last release

* fix: typos in multiple files by @vipocenka in https://github.com/elizaOS/eliza/pull/3111
* feat: save imageUrls for outbound tweets/messages by @alexpaden in https://github.com/elizaOS/eliza/pull/3122
* fix: upgrade openai and vercel ai packages to fix o1 errors by @HashWarlock in https://github.com/elizaOS/eliza/pull/3146
* fix: multi-biome-01 by @AIFlowML in https://github.com/elizaOS/eliza/pull/3180
* fix: plugin-0g by @AIFlowML in https://github.com/elizaOS/eliza/pull/3179
* fix: multi-biome-02 by @AIFlowML in https://github.com/elizaOS/eliza/pull/3181
* fix: plugin-0x by @AIFlowML in https://github.com/elizaOS/eliza/pull/3178
* fix: plugin-3g-generation by @AIFlowML in https://github.com/elizaOS/eliza/pull/3175
* fix: plugin-abstract by @AIFlowML in https://github.com/elizaOS/eliza/pull/3174
* fix: plugin-agentkit by @AIFlowML in https://github.com/elizaOS/eliza/pull/3172
* fix: plugin-akash by @AIFlowML in https://github.com/elizaOS/eliza/pull/3171
* fix: plugin-allora by @AIFlowML in https://github.com/elizaOS/eliza/pull/3169
* docs: fix typos in .md by @comfsrt in https://github.com/elizaOS/eliza/pull/3165
* feat (chore): plugin-coinmarketcap by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/3134
* feat (chore): plugin-coingecko test config and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/3124
* fix: remove duplicated plugins by @tcm390 in https://github.com/elizaOS/eliza/pull/3126
* fix: update provider-utils by @tcm390 in https://github.com/elizaOS/eliza/pull/3189
* fix: extract attribute from raw text instead of normalized json by @tcm390 in https://github.com/elizaOS/eliza/pull/3190
* feat: coingecko advanced -  various pools by network by @0xCardinalError in https://github.com/elizaOS/eliza/pull/3170
* feat: Add edwin plugin to eliza by @galmw in https://github.com/elizaOS/eliza/pull/3045
* feat: plugin desk exchange by @john-xina-p88 in https://github.com/elizaOS/eliza/pull/3096
* docs: Update Twitter to X (Twitter) by @nilaysarma in https://github.com/elizaOS/eliza/pull/3198
* chore: add Biome configuration to Solana ecosystem plugins 07 by @AIFlowML in https://github.com/elizaOS/eliza/pull/3186
* fix: plugin-anyone by @AIFlowML in https://github.com/elizaOS/eliza/pull/3107
* docs: Update faq.md by @Danyylka in https://github.com/elizaOS/eliza/pull/3207
* chore: Fix Typos and Improve Consistency in Community Chat Logs by @gap-editor in https://github.com/elizaOS/eliza/pull/3206
* docs: Add weekly contributor meeting notes by @YoungPhlo in https://github.com/elizaOS/eliza/pull/3204
* fix: think tag from venice by @rferrari in https://github.com/elizaOS/eliza/pull/3203
* fix: Slack download upload attachments by @maxime in https://github.com/elizaOS/eliza/pull/3194
* chore: Update GitHub Actions workflows and documentation by @PixelPil0t1 in https://github.com/elizaOS/eliza/pull/3166
* chore: Standardization of Security Check Identifiers across GoPlus plugin by @Marcofann in https://github.com/elizaOS/eliza/pull/3164
* fix: Update pnpm version during Docker build by @v1xingyue in https://github.com/elizaOS/eliza/pull/3158
* Fix README_JA.md (add unwritten text and fix typo) by @You-saku in https://github.com/elizaOS/eliza/pull/3153
* chore: some fix after v0.1.9 by @v1xingyue in https://github.com/elizaOS/eliza/pull/3141
* feat: Trump character but tweets in Spanish by default by @silasneo in https://github.com/elizaOS/eliza/pull/3119
* feat: TON Plugin: NFT collection, item creation, metadata change and transfer actions by @mikirov in https://github.com/elizaOS/eliza/pull/3211
* docs: rename chat_2024-11-17.md by @Fallengirl in https://github.com/elizaOS/eliza/pull/3210
* feat: Add CREATE_POOL action in MultiversX plugin by @elpulpo0 in https://github.com/elizaOS/eliza/pull/3209
* fix: remove duplicated dependencies by @tcm390 in https://github.com/elizaOS/eliza/pull/3215
* fix: quick-intel plugin optimizations & fixes. by @azep-ninja in https://github.com/elizaOS/eliza/pull/3208
* feat: Add configuration for enabling/disabling Twitter post generation by @tcm390 in https://github.com/elizaOS/eliza/pull/3219
* feat (chore): plugin-cronos test setup and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/3250
* feat (chore) plugin conflux: test config and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/3247
* fix: broken links in documentation by @cypherpepe in https://github.com/elizaOS/eliza/pull/3240
* chore: remove unnecessary provider and transfer code by @madschristensen99 in https://github.com/elizaOS/eliza/pull/3251
* fix: client-alexa by @AIFlowML in https://github.com/elizaOS/eliza/pull/3255
* fix(deps): update dependency vitest [security] by @renovate in https://github.com/elizaOS/eliza/pull/3254
* fix: pnpm install by @tcm390 in https://github.com/elizaOS/eliza/pull/3261
* fix: Dynamic require of "http" is not supported error by @tcm390 in https://github.com/elizaOS/eliza/pull/3262
* chore: develop => main by @odilitime in https://github.com/elizaOS/eliza/pull/3216
* Fix broken links on contributing.md by @johntad110 in https://github.com/elizaOS/eliza/pull/3269
* docs: Add GitHub issues link to CONTRIBUTING.md file by @nilaysarma in https://github.com/elizaOS/eliza/pull/3268
* Fix PG query: Use only 'text' subfield name, field name is not needed here by @esen in https://github.com/elizaOS/eliza/pull/3264
* fix: handle invalid json by @tcm390 in https://github.com/elizaOS/eliza/pull/3258
* docs: fix typos and update broken link in docs by @rebustron in https://github.com/elizaOS/eliza/pull/3270
* chore: fix spelling issues  by @XxAlex74xX in https://github.com/elizaOS/eliza/pull/3271
* fix: DenyLoginSubtask by @tcm390 in https://github.com/elizaOS/eliza/pull/3278
* fix: twitter - add actions suppress action ability. by @azep-ninja in https://github.com/elizaOS/eliza/pull/3286
* fix: rag optimizations/fixes for context. by @azep-ninja in https://github.com/elizaOS/eliza/pull/3248
* fix: quick-intel plugin: optimize template/add suppress init msg by @azep-ninja in https://github.com/elizaOS/eliza/pull/3283
* fix: discord - add actions suppress action ability. by @azep-ninja in https://github.com/elizaOS/eliza/pull/3284
* fix: telegram- add actions suppress action ability. by @azep-ninja in https://github.com/elizaOS/eliza/pull/3285
* feat: (plugin-multiversx) Allow the use of herotag by @elpulpo0 in https://github.com/elizaOS/eliza/pull/3238
* fix: fix docker & types issue by @odilitime in https://github.com/elizaOS/eliza/pull/3220
* fix(core): improve OpenAI-like provider endpoint resolution in `generation.ts` by @btspoony in https://github.com/elizaOS/eliza/pull/3281
* chore: bump version to 0.25.6-alpha.1 by @odilitime in https://github.com/elizaOS/eliza/pull/3306
* chore: develop => main by @tcm390 in https://github.com/elizaOS/eliza/pull/3307
* fix: clean json before normalized by @tcm390 in https://github.com/elizaOS/eliza/pull/3301
* fix: Fix plugin-solana-v2 package.json by @oxy-Op in https://github.com/elizaOS/eliza/pull/3308
* fix: parsing unit test failure by @tcm390 in https://github.com/elizaOS/eliza/pull/3311
* fix: models unit test by @tcm390 in https://github.com/elizaOS/eliza/pull/3312
* fix: read modelConfig from character file by @TbLtzk in https://github.com/elizaOS/eliza/pull/3313
* docs: fix typos and update functions by @Bilogweb3 in https://github.com/elizaOS/eliza/pull/3317
* fix: handleGoogle(options) lost apiKey by @abcfy2 in https://github.com/elizaOS/eliza/pull/3274
* feat: allow plugins to interact w messangerManager to post on telegram by @kesar in https://github.com/elizaOS/eliza/pull/3314
* chore: add missing version property to package.json by @shakkernerd in https://github.com/elizaOS/eliza/pull/3325
* chore: remove remnant files/folders by @shakkernerd in https://github.com/elizaOS/eliza/pull/3326
* docs: fix typos in plugins.md by @aso20455 in https://github.com/elizaOS/eliza/pull/3324
* feat: set package publish access to public by @shakkernerd in https://github.com/elizaOS/eliza/pull/3330
* fix: Twitter logging bug by @vidvidvid in https://github.com/elizaOS/eliza/pull/3327
* chore: develop => main by @shakkernerd in https://github.com/elizaOS/eliza/pull/3332
* feat: Dynamic Plugin Loading (merged_) by @lalalune in https://github.com/elizaOS/eliza/pull/3339
* chore: move default character to agent by @lalalune in https://github.com/elizaOS/eliza/pull/3343
* Delete all plugins by @lalalune in https://github.com/elizaOS/eliza/pull/3342
* feat: remove verifiable inference concept, will be plugin loaded by @lalalune in https://github.com/elizaOS/eliza/pull/3344
* fix: fix default character by @lalalune in https://github.com/elizaOS/eliza/pull/3345
* chore: Remove plugin imports from agent by @avaer in https://github.com/elizaOS/eliza/pull/3346
* chore: Add adapter-sqlite to deps by @avaer in https://github.com/elizaOS/eliza/pull/3357
* feat: v1 CLI utility by @odilitime in https://github.com/elizaOS/eliza/pull/3429
* chore: commit d.a.t.a env configurations by @PisK4 in https://github.com/elizaOS/eliza/pull/3457
* docs: Update readme to clarify difference between eliza-starter and eliza repos by @altcoinalpinist in https://github.com/elizaOS/eliza/pull/3453
* docs: add note about 0x prefix needed for evm private key by @Bleyle823 in https://github.com/elizaOS/eliza/pull/3414
* chore: client/FAQ/Character file Docs update by @madjin in https://github.com/elizaOS/eliza/pull/3410
* chore: update change log by @threewebcode in https://github.com/elizaOS/eliza/pull/3407
* fix: Store stringKnowledge in knowledge when ragKnowledge is enabled (#3434) by @lincheoll in https://github.com/elizaOS/eliza/pull/3435
* docs: fix incorrect image paths in Korean documentation by @gkfyr in https://github.com/elizaOS/eliza/pull/3489
* docs: New remote deployment guide by @bealers in https://github.com/elizaOS/eliza/pull/3501
* chore: adding compass plugin env vars by @royalnine in https://github.com/elizaOS/eliza/pull/3494
* docs: Add weekly contributor meeting notes (2025-02-04 + 2025-02-11) by @YoungPhlo in https://github.com/elizaOS/eliza/pull/3484
* fix: remove --no-frozen-lockfile from Dockerfile by @kyle-veniceai in https://github.com/elizaOS/eliza/pull/3428
* chore: move characters out to submodule by @odilitime in https://github.com/elizaOS/eliza/pull/3509
* fix: refactor string literal `http://localhost` with `SERVER_URL` env var in client by @tenthirtyone in https://github.com/elizaOS/eliza/pull/3511
* docs: Added a Proper Ukrainian README Translation Create README_UA.md by @mdqst in https://github.com/elizaOS/eliza/pull/3483
* feat: Added cachedir to filesystem cache by @Swader in https://github.com/elizaOS/eliza/pull/3291
* fix: CVE-2024-48930 by @anupamme in https://github.com/elizaOS/eliza/pull/2958
* chore: bump version & lockfile by @odilitime in https://github.com/elizaOS/eliza/pull/3523
* fix: Fix bedrock inference by @ebaizel in https://github.com/elizaOS/eliza/pull/3553
* docs: Added sqlite3 errors to Quickstart by @GabrielCartier in https://github.com/elizaOS/eliza/pull/3539
* docs: fix branch naming example in CONTRIBUTING.md by @mdqst in https://github.com/elizaOS/eliza/pull/3532
* chore: Trim  block from Ollama response by @amirkhonov in https://github.com/elizaOS/eliza/pull/3545
* chore: Update and cleanup docs by @madjin in https://github.com/elizaOS/eliza/pull/3584
* feat: Modify the configuration for the plugin-nkn by @iheron in https://github.com/elizaOS/eliza/pull/3570
* docs: enhance README with detailed requirements and contribution guidelines by @avorylli in https://github.com/elizaOS/eliza/pull/3392
* docs: Fix broken links by @sukrucildirr in https://github.com/elizaOS/eliza/pull/3599
* feat: gaianet support set api key by @L-jasmine in https://github.com/elizaOS/eliza/pull/3591
* feat: allow eliza client to configure eliza server base URL via env var by @bguiz in https://github.com/elizaOS/eliza/pull/3589
* chore: docs update by @madjin in https://github.com/elizaOS/eliza/pull/3605
* fix: installing packages from new registry by @daniel-trevino in https://github.com/elizaOS/eliza/pull/3609
* fix: importing plugins from registry by @royalnine in https://github.com/elizaOS/eliza/pull/3611
* fix: set agent from api by @daniel-trevino in https://github.com/elizaOS/eliza/pull/3618
* fix: Fix devcontainer.json Port Mapping Syntax and JSON Structure by @NeoByteXx in https://github.com/elizaOS/eliza/pull/3616
* fix: update chunk & Overlap in rag function by @adventuresinai in https://github.com/elizaOS/eliza/pull/2525
* feat: Showcase page in docs for plugins by @madjin in https://github.com/elizaOS/eliza/pull/3620
* feat: add NEAR AI model provider by @think-in-universe in https://github.com/elizaOS/eliza/pull/3275
* chore(deps): update dependency vitest [security] by @renovate in https://github.com/elizaOS/eliza/pull/3525
* feat: configuration: Set Lava as the default RPC URL for NEAR and Starknet by @nimrod-teich in https://github.com/elizaOS/eliza/pull/3323
* feat: Add support for Secret AI LLM by @iKapitonau in https://github.com/elizaOS/eliza/pull/3615
* chore: Bump version to 0.25.8 by @odilitime in https://github.com/elizaOS/eliza/pull/3632
* chore: fix lockfile by @odilitime in https://github.com/elizaOS/eliza/pull/3633
* update discord link by @odilitime in https://github.com/elizaOS/eliza/pull/3643
* feat: Enable fetching relevant facts in the facts provider. by @LinuxIsCool in https://github.com/elizaOS/eliza/pull/2635
* chore: turbo optimizations by @ryptotalent in https://github.com/elizaOS/eliza/pull/2503
* feat: replace AgentRuntime to his interface to extend client by @kesar in https://github.com/elizaOS/eliza/pull/2388
* chore: remove langchain dependency for text splitting by @Deeptanshu-sankhwar in https://github.com/elizaOS/eliza/pull/3642
* fix: generate structured objects and images with NEAR AI by @think-in-universe in https://github.com/elizaOS/eliza/pull/3644
* chore: stablize develop by @odilitime in https://github.com/elizaOS/eliza/pull/3645
* chore: develop => main (0.25.8 release) by @odilitime in https://github.com/elizaOS/eliza/pull/3522

#### New Contributors

<details>
<summary>View New Contributors</summary>
* @vipocenka made their first contribution in https://github.com/elizaOS/eliza/pull/3111
* @alexpaden made their first contribution in https://github.com/elizaOS/eliza/pull/3122
* @comfsrt made their first contribution in https://github.com/elizaOS/eliza/pull/3165
* @galmw made their first contribution in https://github.com/elizaOS/eliza/pull/3045
* @john-xina-p88 made their first contribution in https://github.com/elizaOS/eliza/pull/3096
* @nilaysarma made their first contribution in https://github.com/elizaOS/eliza/pull/3198
* @Danyylka made their first contribution in https://github.com/elizaOS/eliza/pull/3207
* @gap-editor made their first contribution in https://github.com/elizaOS/eliza/pull/3206
* @PixelPil0t1 made their first contribution in https://github.com/elizaOS/eliza/pull/3166
* @Marcofann made their first contribution in https://github.com/elizaOS/eliza/pull/3164
* @You-saku made their first contribution in https://github.com/elizaOS/eliza/pull/3153
* @silasneo made their first contribution in https://github.com/elizaOS/eliza/pull/3119
* @mikirov made their first contribution in https://github.com/elizaOS/eliza/pull/3211
* @Fallengirl made their first contribution in https://github.com/elizaOS/eliza/pull/3210
* @cypherpepe made their first contribution in https://github.com/elizaOS/eliza/pull/3240
* @johntad110 made their first contribution in https://github.com/elizaOS/eliza/pull/3269
* @esen made their first contribution in https://github.com/elizaOS/eliza/pull/3264
* @rebustron made their first contribution in https://github.com/elizaOS/eliza/pull/3270
* @XxAlex74xX made their first contribution in https://github.com/elizaOS/eliza/pull/3271
* @oxy-Op made their first contribution in https://github.com/elizaOS/eliza/pull/3308
* @TbLtzk made their first contribution in https://github.com/elizaOS/eliza/pull/3313
* @Bilogweb3 made their first contribution in https://github.com/elizaOS/eliza/pull/3317
* @abcfy2 made their first contribution in https://github.com/elizaOS/eliza/pull/3274
* @aso20455 made their first contribution in https://github.com/elizaOS/eliza/pull/3324
* @vidvidvid made their first contribution in https://github.com/elizaOS/eliza/pull/3327
* @PisK4 made their first contribution in https://github.com/elizaOS/eliza/pull/3457
* @altcoinalpinist made their first contribution in https://github.com/elizaOS/eliza/pull/3453
* @Bleyle823 made their first contribution in https://github.com/elizaOS/eliza/pull/3414
* @gkfyr made their first contribution in https://github.com/elizaOS/eliza/pull/3489
* @royalnine made their first contribution in https://github.com/elizaOS/eliza/pull/3494
* @kyle-veniceai made their first contribution in https://github.com/elizaOS/eliza/pull/3428
* @tenthirtyone made their first contribution in https://github.com/elizaOS/eliza/pull/3511
* @Swader made their first contribution in https://github.com/elizaOS/eliza/pull/3291
* @anupamme made their first contribution in https://github.com/elizaOS/eliza/pull/2958
* @GabrielCartier made their first contribution in https://github.com/elizaOS/eliza/pull/3539
* @iheron made their first contribution in https://github.com/elizaOS/eliza/pull/3570
* @avorylli made their first contribution in https://github.com/elizaOS/eliza/pull/3392
* @bguiz made their first contribution in https://github.com/elizaOS/eliza/pull/3589
* @daniel-trevino made their first contribution in https://github.com/elizaOS/eliza/pull/3609
* @NeoByteXx made their first contribution in https://github.com/elizaOS/eliza/pull/3616
* @adventuresinai made their first contribution in https://github.com/elizaOS/eliza/pull/2525
* @think-in-universe made their first contribution in https://github.com/elizaOS/eliza/pull/3275
* @nimrod-teich made their first contribution in https://github.com/elizaOS/eliza/pull/3323
* @iKapitonau made their first contribution in https://github.com/elizaOS/eliza/pull/3615
* @ryptotalent made their first contribution in https://github.com/elizaOS/eliza/pull/2503
* @Deeptanshu-sankhwar made their first contribution in https://github.com/elizaOS/eliza/pull/3642
</details>

#### Full Changelog: https://github.com/elizaOS/eliza/compare/v0.1.9...v0.25.8

---

## v0.1.9 (February 01, 2025)

#### 🚀 Features

- Instagram client #1964
- Client for Telegram account #2839
- XMTP Client #2786
- Twitter post media #2818
- Discord autonomous agent enhancement #2335
- Telegram autonomous agent enhancement #2338
- Direct Client API - Add Delete Agent functionality #2267
- Add an example service #2249

AI & LLM Integrations
- Add support for NVIDIA inference for ElizaOS #2512
- Integrate Livepeer LLM provider #2154
- Add Amazon Bedrock as LLM provider #2769
- Add birdeye plugin #1417

Solana-Related Updates
- Solana plugin improvement for flawless transfers #2340
- Add features to the Solana Agent Kit #2458
- Adding tests for plugin-solana #2345

Ethereum & EVM-Based Plugin Updates
- Plugin evm oz governance #1710
- Add plugin-ethstorage #2737
- Add cross chain swaps through Squid Router #1482
- Add support for gravity chain in EVM plugin #2228
- Add Cronos Evm #2585
- Add plugin-bnb to support BNB chain #2278
- Plugin for OriginTrail Decentralized Knowledge Graph #2380
- Add moralis plugin #2764

Sui-Related Updates
- Use Aggregator swap sui tokens #3012
- Sui supports the secp256k1/secp256r1 algorithms #2476

Cosmos-Related Updates
- IBC transfer on cosmos blockchains #2358
- Cosmos Plugin - IBC swap action #2554

Injective & Other Blockchain Plugins
- injective plugin #1764
- Support mina blockchain #2702
- Add AGW support to the Abstract plugin #2207
- CoinGecko - add price per address functionality #2262
- Add Dex Screener plugin with token price action, evaluators #1865
- Dexscreener trending #2325

#### Bug Fixes

High Priority (Critical Bugs & API Issues)
- DeepSeek API bug: missing API key setting #2186
- Resolve Windows path issue in pnpm build client #2240
- IME causes multiple messages on Enter #2274
- Fix derive key and update remote attestation #2303
- Ensure RA Action reply does not hallucinate #2355
- Prevent app crash when REMOTE_CHARACTER_URLS is undefined #2384
- Check whether REMOTE_CHARACTER_URLS env is defined in starting agent #2382
- Resolve @ai-sdk/provider version conflicts #2714
- Ethers/viem issue in mind network plugin #2783
- Message ID collision in Telegram Client #3053
- ImageVisionModelProvider Not Applied in Runtime #3056
- Handle unsupported image provider #3057
- Fixing the error parsing JSON when an array is a value #3113

Client-Specific Issues & Enhancements
- Don't force root for install #2221
- Align base URL in client if API runs on a different port #2353
- Fix Incorrect Tweet ID Parameter Passed to sendTweet Function #2430
- Unexpected JSON Metadata in Twitter Bot Replies #2712
- Client-twitter homeTimeline name parse bug #2789
- Topics formatting bug at composeState #2788
- Bug in goal objectives update lookup logic #2791
-  doesn't work in tweet post template #2951
- Ensure action tweet replies to agent's initial tweet #2966
- Auto-scrolling issue in client #3115

Plugin Issues & Enhancements
- Missing @elizaos/plugin-b2 #2268
- Export b2Plugin #2291
- Set default Squid Router plugin throttle to 1000 #2386
- Export dexScreenerPlugin #3120
- Remove duplicate litPlugin import #3121

Infrastructure & Build Issues
- Docker images+compose and broken documentation #2347
- Update Zero Gravity (0G) link #2441
- Don't start services twice, improve logging #3007
- Docker build command by skipping eslint files #3110
- Building error #2938

General Code Fixes & Minor Enhancements
- Lint errors #2400
- Fix typo in import statement for Solana AgentKit plugin #2370
- Quickstart.md conflicts #2437
- Typos in supabase seed file #2435
- If VITE_SERVER_PORT is not defined, use default 3000 #2433
- Missing import #2444
- Spell/grammar errors in characters #2447
- Correct STT plugin userId type #2704
- Remove duplicated handlePendingTweet #2715
- Delete plugin-bootstrap sex message #2748
- TON plugin build issue #2757
- Make template message footer more explicit #2774
- Akash splash #2816
- Akash splash bis #2838
- Nvidia nim environment #2817
- Null check #2878
- Default character OpenAI => LlamaLocal #2880
- LOG_JSON_FORMAT env var setting #2881
- Fix abstract package.json #2882
- Client server port #2886
- Handle whitespace in quote conversion #2961
- Remove unnecessary @ts-expect-error directive in chat component #2950
- Correct regex #3054
- Single quote handle bug at parseJsonArray #2802
- OpenAI embedding issue #3003
- Remove dead code #2945
- Add missing plugins in package.json #2947

#### What's Changed (complete)

* fix(plugin-twitter): change prompt to ensure it returns json by @odilitime in https://github.com/elizaOS/eliza/pull/2196
* feat: nft plugin by @tcm390 in https://github.com/elizaOS/eliza/pull/2167
* docs: Add Greek translation for README_GR by @adacapo21 in https://github.com/elizaOS/eliza/pull/2199
* chore: rename ai16z -> elizaOS by @monilpat in https://github.com/elizaOS/eliza/pull/2211
* feature: adding tests for whatsapp plugin by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2213
* fix: DeepSeek API bug:  missing api key setting by @daizhengxue in https://github.com/elizaOS/eliza/pull/2186
* fix: don't force root for install by @proteanx in https://github.com/elizaOS/eliza/pull/2221
* feat: RP for plugin-tee-verifiable-log by @gene-zhan in https://github.com/elizaOS/eliza/pull/1369
* feat: Merge my Eliza Installer with the current start.sh script by @HowieDuhzit in https://github.com/elizaOS/eliza/pull/2229
* feat: add support for gravity chain in EVM plugin by @Stumble in https://github.com/elizaOS/eliza/pull/2228
* docs: Add "What Did You Get Done This Week? #9" notes by @YoungPhlo in https://github.com/elizaOS/eliza/pull/2243
* feat: Add AGW support to the Abstract plugin by @cygaar in https://github.com/elizaOS/eliza/pull/2207
* docs: Add Farsi (Persian )readme by @oxlupo in https://github.com/elizaOS/eliza/pull/2260
* feat: CoinGecko - add price per address functionality by @0xCardinalError in https://github.com/elizaOS/eliza/pull/2262
* fix: test/lint develop by @odilitime in https://github.com/elizaOS/eliza/pull/2266
* feat: Adding plugin for B² Network by @threewebcode in https://github.com/elizaOS/eliza/pull/2010
* fix: (db) add limit param to memory retrieval across adapters by @augchan42 in https://github.com/elizaOS/eliza/pull/2264
* docs: Typo fix README.md by @VitalikBerashvili in https://github.com/elizaOS/eliza/pull/2256
* Minor typo in CHANGELOG.md by @Hack666r in https://github.com/elizaOS/eliza/pull/2255
* fix: missing @elizaos/plugin-b2 by @shakkernerd in https://github.com/elizaOS/eliza/pull/2268
* feat: Add character creation template function to start.sh by @HowieDuhzit in https://github.com/elizaOS/eliza/pull/2232
* fix: resolve Windows path issue in pnpm build client by @KacperKoza343 in https://github.com/elizaOS/eliza/pull/2240
* feat: Add cross chain swaps through Squid Router by @Archethect in https://github.com/elizaOS/eliza/pull/1482
* feat: Plugin evm oz governance by @thetechnocratic in https://github.com/elizaOS/eliza/pull/1710
* feat: Add support for VoyageAI embeddings API by @Firbydude in https://github.com/elizaOS/eliza/pull/1442
* feat: add birdeye plugin by @swizzmagik in https://github.com/elizaOS/eliza/pull/1417
* Revert "feat: Add support for VoyageAI embeddings API" by @shakkernerd in https://github.com/elizaOS/eliza/pull/2290
* docs: Add weekly contributor meeting notes by @YoungPhlo in https://github.com/elizaOS/eliza/pull/2285
* fix: export b2Plugin by @shakkernerd in https://github.com/elizaOS/eliza/pull/2291
* feat: Add an example service by @MonteCrypto999 in https://github.com/elizaOS/eliza/pull/2249
* feat: Gitcoin passport by @0xCardinalError in https://github.com/elizaOS/eliza/pull/2296
* Fix: IME causes multiple messages on Enter (Fixes #2272) by @lincheoll in https://github.com/elizaOS/eliza/pull/2274
* fix: fix derive key and update remote attestation by @HashWarlock in https://github.com/elizaOS/eliza/pull/2303
* feat: Direct Client API - Add Delete Agent functionality by @jason51553262 in https://github.com/elizaOS/eliza/pull/2267
* docs: Update README.md by @lalalune in https://github.com/elizaOS/eliza/pull/2309
* fix: farcaster memory by @CryptoGraffe in https://github.com/elizaOS/eliza/pull/2307
* feat: add getMemoryByIds to database adapters by @bbopar in https://github.com/elizaOS/eliza/pull/2293
* feat: support load character from  character_url by @v1xingyue in https://github.com/elizaOS/eliza/pull/2281
* feat: (echochambers) add dead room detection and conversation starter by @augchan42 in https://github.com/elizaOS/eliza/pull/2248
* chore: Update README.md by @wtfsayo in https://github.com/elizaOS/eliza/pull/2280
* refactor: farcaster client env configuration  by @sin-bufan in https://github.com/elizaOS/eliza/pull/2087
* feat: Onchain Agent Transformer - transform any Eliza agents into unstoppable Solidity smart contracts deployed on 10+ blockchains by @eternal-ai-org in https://github.com/elizaOS/eliza/pull/2319
* feat: add Dex Screener plugin with token price action, evaluators, an… by @hellopleasures in https://github.com/elizaOS/eliza/pull/1865
* refactor: websearch into a service by @chuasonglin1995 in https://github.com/elizaOS/eliza/pull/2195
* fix: correct OPENROUTER_API_KEY env in config by @everimbaq in https://github.com/elizaOS/eliza/pull/2324
* fix: docker images+compose and broken documentation by @JoeyKhd in https://github.com/elizaOS/eliza/pull/2347
* Fix github client README.md by @thomasWos in https://github.com/elizaOS/eliza/pull/2346
* feat: groq image vision provider by @rferrari in https://github.com/elizaOS/eliza/pull/2342
* improvement: using strict types to avoid errors like issue 2164 by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2220
* fix: formatting in Browser section of README.md by @derrekcoleman in https://github.com/elizaOS/eliza/pull/2336
* Update README_TR.md by @sukrucildirr in https://github.com/elizaOS/eliza/pull/2334
* feat: (ragKnowledge) Enhance RAG knowledge handling by @augchan42 in https://github.com/elizaOS/eliza/pull/2351
* feat: add instagram client by @Lukapetro in https://github.com/elizaOS/eliza/pull/1964
* docs: Update README_FR.md by @omahs in https://github.com/elizaOS/eliza/pull/2356
* fix: esure RA Action reply does not hallucinate by @HashWarlock in https://github.com/elizaOS/eliza/pull/2355
* fix: align base url in client if api runs on a different port by @C0ldSmi1e in https://github.com/elizaOS/eliza/pull/2353
* feat: add safe_mode (& cfg_scale) for venice image generation by @proteanx in https://github.com/elizaOS/eliza/pull/2354
* fix: Update package.json of core package by @kesar in https://github.com/elizaOS/eliza/pull/2301
* chore: Reorganizing README translations into a dedicated i18n directory structure by @0xnogo in https://github.com/elizaOS/eliza/pull/2149
* chore: Prep 0.1.9-alpha.1 by @odilitime in https://github.com/elizaOS/eliza/pull/2359
* feat: Enable Multiple remote character urls by @leeran7 in https://github.com/elizaOS/eliza/pull/2328
* chore: lint by @odilitime in https://github.com/elizaOS/eliza/pull/2368
* fix: Fix typo in import statement for Solana AgentKit plugin Update i… by @defitricks in https://github.com/elizaOS/eliza/pull/2370
* feat: dexscreener trending by @0xCardinalError in https://github.com/elizaOS/eliza/pull/2325
* fix: Prevent app crash when REMOTE_CHARACTER_URLS is undefined by @tcm390 in https://github.com/elizaOS/eliza/pull/2384
* Startup Error: ENV misconfig by @0xSero in https://github.com/elizaOS/eliza/pull/2378
* fix: check whether REMOTE_CHARACTER_URLS env is defined in starting agent by @dev-whoan in https://github.com/elizaOS/eliza/pull/2382
* Fix typo by @ericlehong in https://github.com/elizaOS/eliza/pull/2385
* fix: set default Squid Router plugin throttle to 1000 by @Archethect in https://github.com/elizaOS/eliza/pull/2386
* chore: improve descriptions  by @crStiv in https://github.com/elizaOS/eliza/pull/2394
* feat: adding tests for plugin-solana by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2345
* feat: atoma provider by @francis2tm in https://github.com/elizaOS/eliza/pull/2082
* chore: invoke exit code 0 after positive cleanup by @erise133 in https://github.com/elizaOS/eliza/pull/2398
* fix: lint errors by @shakkernerd in https://github.com/elizaOS/eliza/pull/2400
* feat: adding tests for slack client. Moving existing tests to new __tests__ directory. by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2404
* feat: better S3 flexibility by @JoeyKhd in https://github.com/elizaOS/eliza/pull/2379
* feat: adding tests for github client by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2407
* feat: injective plugin by @enigmarikki in https://github.com/elizaOS/eliza/pull/1764
* feat: Integrate Livepeer LLM provider  by @UD1sto in https://github.com/elizaOS/eliza/pull/2154
* chore: remove tate character by @wtfsayo in https://github.com/elizaOS/eliza/pull/2425
* refactor: dockerize smoke tests by @twilwa in https://github.com/elizaOS/eliza/pull/2420
* feat: coinbase agentkit plugin for eliza by @sweetmantech in https://github.com/elizaOS/eliza/pull/2298
* feat: add workflow to block minified JS by @twilwa in https://github.com/elizaOS/eliza/pull/2417
* feat: Code In Plugin, load characters from blockchain by @zo-eth in https://github.com/elizaOS/eliza/pull/2371
* docs: Add notes for weekly contributor meeting on 2025-01-14 by @YoungPhlo in https://github.com/elizaOS/eliza/pull/2426
* fix: Fix Incorrect Tweet ID Parameter Passed to sendTweet Function by @tcm390 in https://github.com/elizaOS/eliza/pull/2430
* fix: quickstart.md conflicts by @wtfsayo in https://github.com/elizaOS/eliza/pull/2437
* Update documentation links  by @donatik27 in https://github.com/elizaOS/eliza/pull/2438
* fix: typos in supabase seed file by @leopardracer in https://github.com/elizaOS/eliza/pull/2435
* feat: Pyth Data Plugin  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2434
* fix: if VITE_SERVER_PORT is not defined, use default 3000 by @JoeyKhd in https://github.com/elizaOS/eliza/pull/2433
* fix: update zero Gravity (0G) link by @Hopium21 in https://github.com/elizaOS/eliza/pull/2441
* feat: ibc transfer on cosmos blockchains by @KacperKoza343 in https://github.com/elizaOS/eliza/pull/2358
* fix TEE Log plugin errors at agent startup by @bundinho in https://github.com/elizaOS/eliza/pull/2415
* fix: missing import  by @wtfsayo in https://github.com/elizaOS/eliza/pull/2444
* feat: improvement to logger by @JoeyKhd in https://github.com/elizaOS/eliza/pull/2396
* feat:update heurist env var examples by @tsubasakong in https://github.com/elizaOS/eliza/pull/2428
* Fix typos in docs by @RubinovaAn1097 in https://github.com/elizaOS/eliza/pull/2449
* fix: Update error message and remove duplicate version field by @MarsonKotovi4 in https://github.com/elizaOS/eliza/pull/2445
* fix: #2373 Fix image description by @ae9is in https://github.com/elizaOS/eliza/pull/2375
* fix: spell/grammar errors in characters  by @Pistasha in https://github.com/elizaOS/eliza/pull/2447
* feat: Telegram autonomous agent enhancement by @azep-ninja in https://github.com/elizaOS/eliza/pull/2338
* feat: add default logger level setting to set the logger level to dis… by @snobbee in https://github.com/elizaOS/eliza/pull/2451
* feat: adding tests for instagram client by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2454
* feat: create version.cmd for windows support by @savageops in https://github.com/elizaOS/eliza/pull/2442
* revert: "refactor: dockerize smoke tests" by @twilwa in https://github.com/elizaOS/eliza/pull/2459
* feat: Add features to the Solana Agent Kit  by @thearyanag in https://github.com/elizaOS/eliza/pull/2458
* chore: set openai as default character's provider by @wtfsayo in https://github.com/elizaOS/eliza/pull/2460
* fix: OPENAI provider being overwritten by LLAMA_LOCAL on pnpm start by @tcm390 in https://github.com/elizaOS/eliza/pull/2465
* Typo fix in read.me by @dedyshkaPexto in https://github.com/elizaOS/eliza/pull/2464
* Fix spelling error by @Dimitrolito in https://github.com/elizaOS/eliza/pull/2456
* fix: conditional use of useQuery in AgentRoute component to prevent runtime errors. by @carlos-cne in https://github.com/elizaOS/eliza/pull/2413
* fix: resolve type error for children in animated.div component by @suleigolden in https://github.com/elizaOS/eliza/pull/2462
* fix: SwapAction in evm-plugin by @B1boid in https://github.com/elizaOS/eliza/pull/2332
* chore: add openai env to smokeTests by @wtfsayo in https://github.com/elizaOS/eliza/pull/2472
* test: adding test configuration and tests for redis adapter by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2470
* feat: tests for supabase and sqlite db adapters by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2468
* fix: linting errors by @shakkernerd in https://github.com/elizaOS/eliza/pull/2474
* chore: remove eslint, prettier, tslint and replace with biome by @0xSero in https://github.com/elizaOS/eliza/pull/2439
* feat: Sui supports the secp256k1/secp256r1 algorithms by @lispking in https://github.com/elizaOS/eliza/pull/2476
* chore: edited the link to the banner by @Olexandr88 in https://github.com/elizaOS/eliza/pull/2483
* feat: Solana plugin improvement for flawless transfers by @sunsakis in https://github.com/elizaOS/eliza/pull/2340
* chore: update createToken.ts by @eltociear in https://github.com/elizaOS/eliza/pull/2493
* chore: corrected the link to the banner by @Olexandr88 in https://github.com/elizaOS/eliza/pull/2491
* feat: introduce Dependency Injection to enhance developer experience by @btspoony in https://github.com/elizaOS/eliza/pull/2115
* chore: corrected the link to the banner by @Olexandr88 in https://github.com/elizaOS/eliza/pull/2490
* chore: corrected the link to the banner by @Olexandr88 in https://github.com/elizaOS/eliza/pull/2489
* Update ElizaOS Documentation link by @Daulox92 in https://github.com/elizaOS/eliza/pull/2495
* chore: handle test cases in version.sh file by @KoZivod88074 in https://github.com/elizaOS/eliza/pull/2485
* feat: adding test configuration and test coverage for binance plugin  by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2482
* feat: Implement character loading from multiple paths and enhance API… by @tercel in https://github.com/elizaOS/eliza/pull/2365
* feat: Load multiple characters from a single remote url by @leeran7 in https://github.com/elizaOS/eliza/pull/2475
* feat: Discord autonomous agent enhancement by @azep-ninja in https://github.com/elizaOS/eliza/pull/2335
* feat: Add Extra Multimedia Support for Telegram Client  by @tcm390 in https://github.com/elizaOS/eliza/pull/2510
* test: api timeout handling for plugin-binance by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2504
* feat: add support for NVIDIA inference for ElizaOS by @AIFlowML in https://github.com/elizaOS/eliza/pull/2512
* feat(plugin-openai): add OpenAI integration for text generation by @0xrubusdata in https://github.com/elizaOS/eliza/pull/2463
* chore: default coinbase agentkit plugin by @sweetmantech in https://github.com/elizaOS/eliza/pull/2505
* docs: add docs/README_JA.md by @eltociear in https://github.com/elizaOS/eliza/pull/2515
* fix: use coingecko headerKey from api config by @visionpixel in https://github.com/elizaOS/eliza/pull/2518
* test: plugin-tee - adjusting project structure and new tests by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2508
* docs: user ID with room ID in MemoryManager and other improvements by @Haisen772 in https://github.com/elizaOS/eliza/pull/2492
* feat: plugin rabbi trader tests by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2520
* chore: add eliza technical report/paper by @tomguluson92 in https://github.com/elizaOS/eliza/pull/2517
* plugin-tts: enhance TTS generation flow and caching by @bfontes in https://github.com/elizaOS/eliza/pull/2506
* feat:add plugin-lightning by @jimtracy1007 in https://github.com/elizaOS/eliza/pull/2429
* fix: develop branch build/start failed by @tcm390 in https://github.com/elizaOS/eliza/pull/2545
* fix: develop branch build/start failed by @tcm390 in https://github.com/elizaOS/eliza/pull/2546
* feat(plugin-devin): implement client-agnostic Devin plugin by @devin-ai-integration in https://github.com/elizaOS/eliza/pull/2549
* feat: Updated READ.me file with pre-requisites to enable telegram bot by @neelkanani in https://github.com/elizaOS/eliza/pull/2547
* chore: remove cleanup step from integration tests workflow by @devin-ai-integration in https://github.com/elizaOS/eliza/pull/2551
* feat: add anthropic image provider for vision by @BitWonka in https://github.com/elizaOS/eliza/pull/2524
* feat: Add more actions to Abstract Plugin by @jonathangus in https://github.com/elizaOS/eliza/pull/2531
* chore: remove cleanup step from integration tests workflow by @devin-ai-integration in https://github.com/elizaOS/eliza/pull/2553
* chore: optimize pnpm cache configuration by @devin-ai-integration in https://github.com/elizaOS/eliza/pull/2555
* feat: add a way to create/store/restore agents in the filesystem by @maxcoto in https://github.com/elizaOS/eliza/pull/2389
* chore(revert): optimize pnpm cache configuration by @devin-ai-integration in https://github.com/elizaOS/eliza/pull/2556
* test configuration and tests for client-lens by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2534
* feat(x spaces): Don't wait for mute, wait for silence by @tcm390 in https://github.com/elizaOS/eliza/pull/2576
* feat: update integration tests workflow with improved caching by @devin-ai-integration in https://github.com/elizaOS/eliza/pull/2589
* feat(plugin-agentkit): test config and tests by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2573
* feat(plugin-coingecko): coingecko trending advanced by @0xCardinalError in https://github.com/elizaOS/eliza/pull/2568
* feat(plugin-holdstation): add plugin holdstation swap by @cuongnguyenthai in https://github.com/elizaOS/eliza/pull/2596
* Add 'node-compile-cache' to '.gitignore' by @jazzvaz in https://github.com/elizaOS/eliza/pull/2597
* feat(plugin-farcaster): test config and test coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2567
* fix:Incorrect boolean parsing for ENABLE_OPEN_AI_COMMUNITY_PLUGIN setting #2559 by @lincheoll in https://github.com/elizaOS/eliza/pull/2560
* feat: add three new langs into TTS by @tomguluson92 in https://github.com/elizaOS/eliza/pull/2562
* docs: Add "What Did You Get Done This Week? #10" notes by @YoungPhlo in https://github.com/elizaOS/eliza/pull/2558
* feat: Add Cronos Evm by @leejw51crypto in https://github.com/elizaOS/eliza/pull/2585
* feat: add router nitro plugin by @RaveenaBhasin in https://github.com/elizaOS/eliza/pull/2590
* feat(plugin-new):  initia plugin + chore revert to integrationTests from stable release 0.1.7 by @boohyunsik in https://github.com/elizaOS/eliza/pull/2448
* feat: nvidia-nim-plugin by @AIFlowML in https://github.com/elizaOS/eliza/pull/2599
* fix: Add instruction to escape quotes on JSON generation by @lalalune in https://github.com/elizaOS/eliza/pull/2604
* feat(new-plugin): 0x plugin to swap on evms by @chuasonglin1995 in https://github.com/elizaOS/eliza/pull/2329
* fix: add missing plugin by @tcm390 in https://github.com/elizaOS/eliza/pull/2626
* chore(deps): update dependency vite [security] by @renovate in https://github.com/elizaOS/eliza/pull/2627
* chore(deps): update dependency vite [security] by @renovate in https://github.com/elizaOS/eliza/pull/2629
* feat: add plugin-bnb to support BNB chain by @pythonberg1997 in https://github.com/elizaOS/eliza/pull/2278
* chore: fix develop build and tests by @wtfsayo in https://github.com/elizaOS/eliza/pull/2646
* feat: plugin for OriginTrail Decentralized Knowledge Graph by @brkagithub in https://github.com/elizaOS/eliza/pull/2380
* fix: Resolve chat error in openai-plugin (#2649) by @lincheoll in https://github.com/elizaOS/eliza/pull/2650
* feat: Cosmos Plugin - IBC swap action by @stanislawkurzypBD in https://github.com/elizaOS/eliza/pull/2554
* fix: a typo bug in conflux plugin by @siphonelee in https://github.com/elizaOS/eliza/pull/2654
* fix debug targets to show elizalogger debug messages by @augchan42 in https://github.com/elizaOS/eliza/pull/2670
* feat(email-plugin): add email-plugin + improve: fixed avail plugin duplicate dependency by @jteso in https://github.com/elizaOS/eliza/pull/2645
* chore(spelling-fixes): docs by @nnsW3 in https://github.com/elizaOS/eliza/pull/2669
* feat(new-plugin): suno Eliza plugin by @Freytes in https://github.com/elizaOS/eliza/pull/2656
* Revert "feat(new-plugin): suno Eliza plugin" by @wtfsayo in https://github.com/elizaOS/eliza/pull/2673
* feat: Implement runProcess function in test library by @VolodymyrBg in https://github.com/elizaOS/eliza/pull/2672
* fix: remove wrong comment by @tcm390 in https://github.com/elizaOS/eliza/pull/2683
* feat: chainbase plugin for eliza by @lxcong in https://github.com/elizaOS/eliza/pull/2162
* fix debug targets to show elizalogger debug messages by @augchan42 in https://github.com/elizaOS/eliza/pull/2685
* feat: custom s3 endpoint url for 'plugin-node' by @dtbuchholz in https://github.com/elizaOS/eliza/pull/2176
* chore: lint pass by @odilitime in https://github.com/elizaOS/eliza/pull/2580
* feat(plugin-new): Official SimsAI Release V1.0 by @simsaidev in https://github.com/elizaOS/eliza/pull/2618
* chore: fix types syntax issue by @wtfsayo in https://github.com/elizaOS/eliza/pull/2694
* feat: add adapter-qdrant by @oxf71 in https://github.com/elizaOS/eliza/pull/2322
* feat(new-plugin): suno music generation  by @Freytes in https://github.com/elizaOS/eliza/pull/2679
* feat(new-plugin): udio music generation for eliza by @Freytes in https://github.com/elizaOS/eliza/pull/2660
* feat(new-plugin): Eliza OmniFlix Plugin by @OmniflixBlockEater in https://github.com/elizaOS/eliza/pull/2693
* fix(ragKnowledge): Ensure scoped IDs are properly used to check for existing knowledge by @augchan42 in https://github.com/elizaOS/eliza/pull/2690
* feat: Hyperbolic-plugin  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2701
* Mostly aesthetic changes, fixed some wonky bullets and numbered lists. by @bealers in https://github.com/elizaOS/eliza/pull/2698
* feat(new-plugin): eliza samsung smarthings plugin by @Freytes in https://github.com/elizaOS/eliza/pull/2678
* Improve GitBook Provider Output by Including Query Context by @Evan-zkLinkLabs in https://github.com/elizaOS/eliza/pull/2659
* feat: Plugin football by @suleigolden in https://github.com/elizaOS/eliza/pull/2461
* feat: [Space] improving handling of user ids and memory storage by @worksgoodcompany in https://github.com/elizaOS/eliza/pull/2686
* fix: correct stt plugin userId type by @tcm390 in https://github.com/elizaOS/eliza/pull/2704
* fix: Unexpected JSON Metadata in Twitter Bot Replies by @tcm390 in https://github.com/elizaOS/eliza/pull/2712
* fix: remove duplicated handlePendingTweet by @tcm390 in https://github.com/elizaOS/eliza/pull/2715
* feat: add error message by @tcm390 in https://github.com/elizaOS/eliza/pull/2717
* Remove the log as it may potentially cause the app to crash by @tcm390 in https://github.com/elizaOS/eliza/pull/2716
* feat: improve twitter parsing by @tcm390 in https://github.com/elizaOS/eliza/pull/2730
* feat: move cleanJsonResponse to parsing by @tcm390 in https://github.com/elizaOS/eliza/pull/2732
* fix: delete plugin-bootstrap sex message, because it will cause some apis sensitive alerts by @klren0312 in https://github.com/elizaOS/eliza/pull/2748
* feat: add lit plugin by @dezcalimese in https://github.com/elizaOS/eliza/pull/2703
* feat(plugin-holdstation): add plugin holdstation swap by @dev-holdstation in https://github.com/elizaOS/eliza/pull/2741
* feat: Restrict discord bot to respond only in allowed channels (#2742) by @lincheoll in https://github.com/elizaOS/eliza/pull/2743
* chore: adds hyperliquid env variables to env example by @alex1092 in https://github.com/elizaOS/eliza/pull/2736
* feat: Add Sei Plugin by @mj850 in https://github.com/elizaOS/eliza/pull/2720
* feat(ton-plugin): add debug scripts and fix the transfer by @jinbangyi in https://github.com/elizaOS/eliza/pull/2744
* chore(core/evaluators): source example links by @guspan-tanadi in https://github.com/elizaOS/eliza/pull/2724
* fix: resolve @ai-sdk/provider version conflicts by @antman1p in https://github.com/elizaOS/eliza/pull/2714
* Bug/fix ton plugin by @ajkraus04 in https://github.com/elizaOS/eliza/pull/2755
* fix: ton plugin build issue by @wtfsayo in https://github.com/elizaOS/eliza/pull/2757
* feat: biome automation via python with reporting by @AIFlowML in https://github.com/elizaOS/eliza/pull/2733
* chore: Use latest allora-sdk version in the Allora Plugin by @conache in https://github.com/elizaOS/eliza/pull/2707
* feat(new-plugin): adding Imgflip plugin for generating memes using the imgflip.com API by @krustevalexander in https://github.com/elizaOS/eliza/pull/2711
* feat: Add plugin-ethstorage by @iteyelmp in https://github.com/elizaOS/eliza/pull/2737
* feat: minimal workflow to resolve ephemeral check by @twilwa in https://github.com/elizaOS/eliza/pull/2735
* feat: support mina blockchain by @lispking in https://github.com/elizaOS/eliza/pull/2702
* client-eliza-home: test config and test coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2719
* feat: create /.turbo/config.json by @twilwa in https://github.com/elizaOS/eliza/pull/2768
* feat: Add Amazon Bedrock as LLM provider by @ebaizel in https://github.com/elizaOS/eliza/pull/2769
* Fix path in all files by @LouisVannobel in https://github.com/elizaOS/eliza/pull/2763
* feat(new-plugin): added zerion plugin by @pranav-singhal in https://github.com/elizaOS/eliza/pull/2766
* feat: add moralis plugin by @bharathbabu-moralis in https://github.com/elizaOS/eliza/pull/2764
* feat(edriziai): Add Edriziai Startup Mentor AI Assistant by @ccross2 in https://github.com/elizaOS/eliza/pull/2687
* docs: add docs on configuring secrets for multi agent workflows. by @LinuxIsCool in https://github.com/elizaOS/eliza/pull/2632
* feat(new-plugin): adding intelligent email evaluation and automation by @Cooops in https://github.com/elizaOS/eliza/pull/2709
* feat(new-plugin): add Form chain plugin by @tmarwen in https://github.com/elizaOS/eliza/pull/2728
* feat: added Ankr plugin by @AIFlowML in https://github.com/elizaOS/eliza/pull/2773
* feat(new-plugin): bittensor bitmind api for eliza by @benliang99 in https://github.com/elizaOS/eliza/pull/2682
* feat: Add plugin-dcap by @Liao1 in https://github.com/elizaOS/eliza/pull/2638
* chore: enable turbo cache by @wtfsayo in https://github.com/elizaOS/eliza/pull/2775
* fix: make template message footer more explicit by @HashWarlock in https://github.com/elizaOS/eliza/pull/2774
* docs: add one click deployment to docs by @KanishkKhurana in https://github.com/elizaOS/eliza/pull/2631
* feat: Add swap & improvements for multiversx-plugin by @mgavrila in https://github.com/elizaOS/eliza/pull/2651
* chore: allow custom TEE log path by @batudo in https://github.com/elizaOS/eliza/pull/2616
* feat(new-adapter): mongo-db adaptor by @jobyid in https://github.com/elizaOS/eliza/pull/1427
* chore(plugin-coinbase): Update tokenContract.ts by @AdventureSeeker987 in https://github.com/elizaOS/eliza/pull/2781
* chore(add-tests): plugin abstract: test config and tests by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2621
* feat(client-alexa): Basic Alexa skill notification by @brandon1525 in https://github.com/elizaOS/eliza/pull/2564
* feat(new-plugin): quick intel plugin for token security analysis by @azep-ninja in https://github.com/elizaOS/eliza/pull/2391
* feat: add Mind Network plugin by @zy-bc-ai in https://github.com/elizaOS/eliza/pull/2431
* fix: goal updating bug in the goal evaluator's handler of plugin-bootstrap by @Alirun in https://github.com/elizaOS/eliza/pull/2725
* fix: ethers/viem issue in mind network plugin by @wtfsayo in https://github.com/elizaOS/eliza/pull/2783
* fix: client-twitter homeTimeline name parse bug by @JhChoy in https://github.com/elizaOS/eliza/pull/2789
* fix: topics formatting bug at composeState by @JhChoy in https://github.com/elizaOS/eliza/pull/2788
* Fix: DTS Error mismatch LanguageModelV1interface/Version in ai-sdk mistral model by @juanc07 in https://github.com/elizaOS/eliza/pull/2782
* feat: plugin Solana web3.js V2 & automated LPing on Orca by @calintje in https://github.com/elizaOS/eliza/pull/2136
* feat: news-plugin by @ileana-pr in https://github.com/elizaOS/eliza/pull/1248
* fix: bug in goal objectives update lookup logic by @Alirun in https://github.com/elizaOS/eliza/pull/2791
* fix: adding exclusion for extra folder for faster future rebase by @AIFlowML in https://github.com/elizaOS/eliza/pull/2813
* feat: Add Access Token Management to MultiversX Plugin by @elpulpo0 in https://github.com/elizaOS/eliza/pull/2810
* chore: plugin-0g test configuration and test coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2805
* test: plugin-0x test configuration and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2807
* fix: akash splash  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2816
* fix: nvidia nim environment by @AIFlowML in https://github.com/elizaOS/eliza/pull/2817
* feat: improve message parsing by @tcm390 in https://github.com/elizaOS/eliza/pull/2772
* fix: plugin-zksync-era multiple errors and issues as documented by @AIFlowML in https://github.com/elizaOS/eliza/pull/2819
* docs: Create client-discord readme.md by @actuallyrizzn in https://github.com/elizaOS/eliza/pull/2812
* docs: Update client-telegram README.md by @actuallyrizzn in https://github.com/elizaOS/eliza/pull/2814
* docs: update embedding function by @rubinovitz in https://github.com/elizaOS/eliza/pull/2821
* feat: twitter post media by @tcm390 in https://github.com/elizaOS/eliza/pull/2818
* fix: plugin-tts  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2829
* fix: plugin-twitter by @AIFlowML in https://github.com/elizaOS/eliza/pull/2827
* fix: plugin-udio  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2824
* fix: plugin-video-generation Fixed multiple non criticla issues. by @AIFlowML in https://github.com/elizaOS/eliza/pull/2823
* fix: plugin-zerion  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2822
* feat(new-plugin): create gelato plugin relay by @anirudhmakhana in https://github.com/elizaOS/eliza/pull/2799
* fix: still run Farcaster client loop if error by @rubinovitz in https://github.com/elizaOS/eliza/pull/2830
* feat: add new readmes, move some others for consistency by @madjin in https://github.com/elizaOS/eliza/pull/2828
* btcfun Plugin for Eliza by @Nevermore-Ray in https://github.com/elizaOS/eliza/pull/2797
* feat: XMTP Client by @humanagent in https://github.com/elizaOS/eliza/pull/2786
* feat(new-plugin): trikon plugin for eliza by @AmriteshTrikon in https://github.com/elizaOS/eliza/pull/2653
* chore(update-plugin-initialization): btcfun & trikon plugin by @Nevermore-Ray in https://github.com/elizaOS/eliza/pull/2643
* fix: plugin-thirdweb by @AIFlowML in https://github.com/elizaOS/eliza/pull/2833
* fix(deps): update dependency cookie to v0.7.0 [security] by @renovate in https://github.com/elizaOS/eliza/pull/2834
* fix: plugin-ton by @AIFlowML in https://github.com/elizaOS/eliza/pull/2832
* fix: plugin-tee-marlin by @AIFlowML in https://github.com/elizaOS/eliza/pull/2837
* fix: plugin-tee-veriafiable-log by @AIFlowML in https://github.com/elizaOS/eliza/pull/2836
* fix: akash splash bis by @AIFlowML in https://github.com/elizaOS/eliza/pull/2838
* fix: plugin-story by @AIFlowML in https://github.com/elizaOS/eliza/pull/2844
* fix: plugin-sui by @AIFlowML in https://github.com/elizaOS/eliza/pull/2843
* fix: plugin-suno by @AIFlowML in https://github.com/elizaOS/eliza/pull/2840
* fix(deps): update bs58 version to resolve integration test dependency issues by @devin-ai-integration in https://github.com/elizaOS/eliza/pull/2848
* feat(new-plugin): A plugin for the Zilliqa blockchain by @rrw-zilliqa in https://github.com/elizaOS/eliza/pull/2842
* refactor: simplify and fix exports in Imgflip meme generation plugin. by @krustevalexander in https://github.com/elizaOS/eliza/pull/2846
* feat: client for Telegram account by @tgaru in https://github.com/elizaOS/eliza/pull/2839
* chore(add-tests): plugin 3d generation: test config and test coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2850
* chore(add-tests): plugin anyone: test config and test coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2854
* feat(new-plugin): support apro plugin by @fifahuihua in https://github.com/elizaOS/eliza/pull/2794
* feat(new-plugin): add arbitrage plugin with example character by @mmarfinetz in https://github.com/elizaOS/eliza/pull/2784
* feat(new-plugin): deva client integration by @stopmalone in https://github.com/elizaOS/eliza/pull/1238
* fix: single quote handle bug at parseJsonArray by @JhChoy in https://github.com/elizaOS/eliza/pull/2802
* fix: fix merge conflict by @tcm390 in https://github.com/elizaOS/eliza/pull/2873
* fix: null check by @tcm390 in https://github.com/elizaOS/eliza/pull/2878
* fix: default character openai => llamalocal by @odilitime in https://github.com/elizaOS/eliza/pull/2880
* fix: LOG_JSON_FORMAT env var setting by @odilitime in https://github.com/elizaOS/eliza/pull/2881
* fix: fix abstract package.json by @odilitime in https://github.com/elizaOS/eliza/pull/2882
* chore: bump version to 0.1.9 by @odilitime in https://github.com/elizaOS/eliza/pull/2883
* fix: client server port by @tcm390 in https://github.com/elizaOS/eliza/pull/2886
* Add more data when scrapping tweets by @viv-cheung in https://github.com/elizaOS/eliza/pull/2644
* Update pnpm to v9.15.0 [SECURITY] by @renovate in https://github.com/elizaOS/eliza/pull/2888
* Update dependency systeminformation to v5.23.8 [SECURITY] by @renovate in https://github.com/elizaOS/eliza/pull/2887
* fet: use axios to fetch price and support two types private key by @v1xingyue in https://github.com/elizaOS/eliza/pull/2879
* fix: plugin-omniflix by @AIFlowML in https://github.com/elizaOS/eliza/pull/2902
* fix: plugin-open-weather by @AIFlowML in https://github.com/elizaOS/eliza/pull/2899
* fix: plugin-opacity by @AIFlowML in https://github.com/elizaOS/eliza/pull/2900
* fix: plugin-openai by @AIFlowML in https://github.com/elizaOS/eliza/pull/2898
* fix(patch): pnpm/@solana-developers to fix @coral-xyz 'BN' export by @wtfsayo in https://github.com/elizaOS/eliza/pull/2901
* fix: plugin-primus by @AIFlowML in https://github.com/elizaOS/eliza/pull/2893
* fix: plugin-quai  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2892
* fix: plugin-quick-intel by @AIFlowML in https://github.com/elizaOS/eliza/pull/2890
* fix: plugin-sei by @AIFlowML in https://github.com/elizaOS/eliza/pull/2877
* fix: plugin-sgx by @AIFlowML in https://github.com/elizaOS/eliza/pull/2872
* fix: plugin-starknet by @AIFlowML in https://github.com/elizaOS/eliza/pull/2866
* fix: plugin-spheron by @AIFlowML in https://github.com/elizaOS/eliza/pull/2870
* fix: plugin-squid-router by @AIFlowML in https://github.com/elizaOS/eliza/pull/2868
* Update LICENSE by @maximevtush in https://github.com/elizaOS/eliza/pull/2903
* fix: plugin-arbitrage  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2905
* chore: fix spell errors by @Pricstas in https://github.com/elizaOS/eliza/pull/2909
* feat(arbitrage): improve gas price optimization and volume calculation by @mmarfinetz in https://github.com/elizaOS/eliza/pull/2869
* chore(add-tests): plugin-asterai -> test coverage and config by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2860
* ci: changes to allow package scoping to public by @shakkernerd in https://github.com/elizaOS/eliza/pull/2928
* fix: missing version prop in package.json by @shakkernerd in https://github.com/elizaOS/eliza/pull/2929
* fix: invalid npm package naming convention by @shakkernerd in https://github.com/elizaOS/eliza/pull/2930
* chore: inconsistent folder naming conventipn by @shakkernerd in https://github.com/elizaOS/eliza/pull/2931
* feat: add public access to packages. by @shakkernerd in https://github.com/elizaOS/eliza/pull/2933
* fix template typos by @michavie in https://github.com/elizaOS/eliza/pull/2932
* feat: new model provider for LM Studio by @eric2hen in https://github.com/elizaOS/eliza/pull/2913
* fix: plugin-nft-generation by @AIFlowML in https://github.com/elizaOS/eliza/pull/2934
* fix: building error by @tcm390 in https://github.com/elizaOS/eliza/pull/2938
* fix: plugin-news by @AIFlowML in https://github.com/elizaOS/eliza/pull/2940
* fix: plugin-nft-collection by @AIFlowML in https://github.com/elizaOS/eliza/pull/2937
* fix: plugin-near by @AIFlowML in https://github.com/elizaOS/eliza/pull/2941
* fix: plugin-movement by @AIFlowML in https://github.com/elizaOS/eliza/pull/2943
* fix: plugin-multiversx by @AIFlowML in https://github.com/elizaOS/eliza/pull/2942
* fix: remove dead code by @tcm390 in https://github.com/elizaOS/eliza/pull/2945
* fix: add missing plugins in package.json by @tcm390 in https://github.com/elizaOS/eliza/pull/2947
* fix:  doesn't work in tweet post template  by @tcm390 in https://github.com/elizaOS/eliza/pull/2951
* fix: plugin-massa by @AIFlowML in https://github.com/elizaOS/eliza/pull/2955
* fix-plugin-mina by @AIFlowML in https://github.com/elizaOS/eliza/pull/2954
* fix: mind-network by @AIFlowML in https://github.com/elizaOS/eliza/pull/2953
* fix: plugin-moralis by @AIFlowML in https://github.com/elizaOS/eliza/pull/2952
* fix: remove unnecessary @ts-expect-error directive in chat component by @wonseokjung in https://github.com/elizaOS/eliza/pull/2950
* feat(plugin-di): add `Dependency Injection` support for services and clients, and di plugin samples to _examples as new folder by @btspoony in https://github.com/elizaOS/eliza/pull/2855
* fix: handle whitespace in quote conversion by @tcm390 in https://github.com/elizaOS/eliza/pull/2961
* fix: plugin-letzai by @AIFlowML in https://github.com/elizaOS/eliza/pull/2960
* fix: plugin-lightning by @AIFlowML in https://github.com/elizaOS/eliza/pull/2959
* fix: plugin-lit by @AIFlowML in https://github.com/elizaOS/eliza/pull/2957
* fix: plugin-obsidian by @AIFlowML in https://github.com/elizaOS/eliza/pull/2906
* fix: plugin-router-nitro by @AIFlowML in https://github.com/elizaOS/eliza/pull/2884
* fix: ensure action tweet replies to agent's initial tweet by @tcm390 in https://github.com/elizaOS/eliza/pull/2966
* fix: plugin-lensnetwork  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2965
* chore: bump pnpm for remaining workflows by @wtfsayo in https://github.com/elizaOS/eliza/pull/2968
* fix(lint): plugin-intiface by @AIFlowML in https://github.com/elizaOS/eliza/pull/2971
* fix(lint): plugin-iq6900 by @AIFlowML in https://github.com/elizaOS/eliza/pull/2970
* fix: plugin-irys by @AIFlowML in https://github.com/elizaOS/eliza/pull/2969
* fix(lint): plugin-injective by @AIFlowML in https://github.com/elizaOS/eliza/pull/2973
* fix: plugin-initia  by @AIFlowML in https://github.com/elizaOS/eliza/pull/2974
* fix(lint): plugin-imgflip by @AIFlowML in https://github.com/elizaOS/eliza/pull/2976
* fix(lint): plugin-image-generation by @AIFlowML in https://github.com/elizaOS/eliza/pull/2978
* feat(chore): plugin-arbitrage test config and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2983
* feat: improve instagram client by @derrix060 in https://github.com/elizaOS/eliza/pull/2975
* feat(chore): plugin-apro -> test coverage and test config by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2980
* fix README's CONTRIBUTING.md link in plugin-multiversx package by @elpulpo0 in https://github.com/elizaOS/eliza/pull/2985
* docs: fix broken links to github by @yaruno in https://github.com/elizaOS/eliza/pull/2987
* Update lpmanager.character.json by @Dahka2321 in https://github.com/elizaOS/eliza/pull/2921
* chore: correction typos chat_2024-12-04.md by @futreall in https://github.com/elizaOS/eliza/pull/2986
* feat(more-actions): Lit Protocol plugin by @madschristensen99 in https://github.com/elizaOS/eliza/pull/2912
* fix: re-enable wtfsayonara's patch by @odilitime in https://github.com/elizaOS/eliza/pull/2993
* chore: lockfile audit by @odilitime in https://github.com/elizaOS/eliza/pull/2994
* Update of the complete translation of README_FR.md [FR] by @YohanGH in https://github.com/elizaOS/eliza/pull/2964
* feat (chore): plugin avalanche test config and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2999
* feat (chore): plugin avail test config and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2997
* feat (chore): plugin-autonome test config and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2992
* fix: OpenAI embedding issue by @ileana-pr in https://github.com/elizaOS/eliza/pull/3003
* fix: don't start services twice, improve logging by @odilitime in https://github.com/elizaOS/eliza/pull/3007
* fix: deepgram transcription null check by @tcm390 in https://github.com/elizaOS/eliza/pull/3014
* fix: llava model parsing Issue  by @tcm390 in https://github.com/elizaOS/eliza/pull/3008
* fix(lint): plugin-hyperliquid by @AIFlowML in https://github.com/elizaOS/eliza/pull/3011
* fix(lint):  plugin-holdstation by @AIFlowML in https://github.com/elizaOS/eliza/pull/3015
* fix(lint): plugin-goplus by @AIFlowML in https://github.com/elizaOS/eliza/pull/3016
* chore(lint-BIOME): Improving errors and warnings by @0xSero in https://github.com/elizaOS/eliza/pull/2990
* fix: client-slack & adapter-postgres: Ensure the connection between user and room before creating a memory,… by @maxime in https://github.com/elizaOS/eliza/pull/3006
* fix: change handleAnthropic default mode to auto by @Jesscha in https://github.com/elizaOS/eliza/pull/3018
* fix: spelling issue  by @sky-coderay in https://github.com/elizaOS/eliza/pull/3041
* fix(lint): plugin-ethstorage by @AIFlowML in https://github.com/elizaOS/eliza/pull/3039
* fix(lint): plugin-evm by @AIFlowML in https://github.com/elizaOS/eliza/pull/3038
* fix(lint): plugin-flow by @AIFlowML in https://github.com/elizaOS/eliza/pull/3036
* fix(lint): plugin-football by @AIFlowML in https://github.com/elizaOS/eliza/pull/3035
* fix(lint): plugin-form by @AIFlowML in https://github.com/elizaOS/eliza/pull/3033
* fix(lint): plugin-fuel by @AIFlowML in https://github.com/elizaOS/eliza/pull/3028
* fix(lint): plugin-gelato by @AIFlowML in https://github.com/elizaOS/eliza/pull/3027
* fix(lint): plugin-genlayer by @AIFlowML in https://github.com/elizaOS/eliza/pull/3025
* fix(lint): plugin-giphy by @AIFlowML in https://github.com/elizaOS/eliza/pull/3024
* fix(lint): plugin-goat by @AIFlowML in https://github.com/elizaOS/eliza/pull/3019
* fix(lint): plugin-gitcoin-passport by @AIFlowML in https://github.com/elizaOS/eliza/pull/3022
* fix(lint): plugin-gitbook  by @AIFlowML in https://github.com/elizaOS/eliza/pull/3023
* feat: add  Fleek Eliza deployment to Readme_CN by @tobySolutions in https://github.com/elizaOS/eliza/pull/3048
* fix: correct regex by @tcm390 in https://github.com/elizaOS/eliza/pull/3054
* fix: Message id collision in Telegram Client by @tcm390 in https://github.com/elizaOS/eliza/pull/3053
* fix: ImageVisionModelProvider Not Applied in Runtime for Image Description Service by @tcm390 in https://github.com/elizaOS/eliza/pull/3056
* fix: handle unsupported image provider by @tcm390 in https://github.com/elizaOS/eliza/pull/3057
* feat: use Aggregator swap sui tokens by @v1xingyue in https://github.com/elizaOS/eliza/pull/3012
* fix: plugin-devin lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3070
* fix: plugin-binance lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3089
* fix: plugin-birdeye lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3088
* fix: plugin-bittensor lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3087
* fix: plugin-Chainbase lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3085
* fix: plugin-coingecko lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3084
* fix: plugin-coinmarketcap lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3082
* fix: plugin-conflux lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3080
* fix: plugin-cosmos lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3077
* fix: plugin-cronos lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3076
* fix: plugin-bnb lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3086
* fix: Rename file with typo in MVX plugin by @PhyByte in https://github.com/elizaOS/eliza/pull/3026
* docs: Add Arabic translation for README by @EmanHerawy in https://github.com/elizaOS/eliza/pull/3081
* fix: plugin-cronoszkevm lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3075
* fix: plugin-dcap lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3074
* fix: plugin-b2  lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3091
* fix: plugin-depin lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3073
* fix: plugin-dexscreener lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3069
* fix: the unexpected corrections for plugin-di caused by biome lint by @btspoony in https://github.com/elizaOS/eliza/pull/3052
* fix: fix-plugin-di lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3066
* fix: plugin-avalanche lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3092
* fix: plugin-echochamber lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3063
* fix: plugin-dkg lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3065
* fix: plugin-mail lint by @AIFlowML in https://github.com/elizaOS/eliza/pull/3061
* feat: 3049 add demo api access coingecko by @MichaelDeng03 in https://github.com/elizaOS/eliza/pull/3050
* fix(lint): email-automation by @AIFlowML in https://github.com/elizaOS/eliza/pull/3044
* fix: plugin-avail  by @AIFlowML in https://github.com/elizaOS/eliza/pull/3094
* docs(packages/adapters): navigate section links by @guspan-tanadi in https://github.com/elizaOS/eliza/pull/3005
* fix: fixed build error in plugin-email-automation  by @samarth30 in https://github.com/elizaOS/eliza/pull/3097
* fix: plugin-icp refactored by @AIFlowML in https://github.com/elizaOS/eliza/pull/3010
* fix: plugin-asterai by @AIFlowML in https://github.com/elizaOS/eliza/pull/3101
* fix: plugin-autonome-v1 by @AIFlowML in https://github.com/elizaOS/eliza/pull/3098
* fix: plugin-arthera-biome by @AIFlowML in https://github.com/elizaOS/eliza/pull/3102
* fix: plugin-aptos by @AIFlowML in https://github.com/elizaOS/eliza/pull/3104
* docs: Add "What Did You Get Done This Week? 11" notes by @YoungPhlo in https://github.com/elizaOS/eliza/pull/3103
* fix: fixing the error parsing json when an array is a value in a JSON… by @maxime in https://github.com/elizaOS/eliza/pull/3113
* chore: updated .gitignore + removed build files by @wtfsayo in https://github.com/elizaOS/eliza/pull/3117
* fix: auto-scrolling issue in client by @tcm390 in https://github.com/elizaOS/eliza/pull/3115
* fix: plugin-apro by @AIFlowML in https://github.com/elizaOS/eliza/pull/3106
* feat (chore): plugin-chainbase test config and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/3072
* feat (chore): plugin bittensor test config and coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/3064
* feat (chore): plugin-bootstrap: test config and test coverage by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/3068
* fix: docker build command by skipping eslint files by @jonathangus in https://github.com/elizaOS/eliza/pull/3110
* fix: export dexScreenerPlugin by @shakkernerd in https://github.com/elizaOS/eliza/pull/3120
* fix:chore(plugin-chainbase): add missing comma in package.json by @akugone in https://github.com/elizaOS/eliza/pull/3118
* fix: remove duplicate litPlugin import by @shakkernerd in https://github.com/elizaOS/eliza/pull/3121
* chore: dev => main 0.1.9 by @odilitime in https://github.com/elizaOS/eliza/pull/2361

#### New Contributors

<details>
<summary>View New Contributors</summary>
* @adacapo21 made their first contribution in https://github.com/elizaOS/eliza/pull/2199
* @gene-zhan made their first contribution in https://github.com/elizaOS/eliza/pull/1369
* @Stumble made their first contribution in https://github.com/elizaOS/eliza/pull/2228
* @oxlupo made their first contribution in https://github.com/elizaOS/eliza/pull/2260
* @VitalikBerashvili made their first contribution in https://github.com/elizaOS/eliza/pull/2256
* @Hack666r made their first contribution in https://github.com/elizaOS/eliza/pull/2255
* @KacperKoza343 made their first contribution in https://github.com/elizaOS/eliza/pull/2240
* @thetechnocratic made their first contribution in https://github.com/elizaOS/eliza/pull/1710
* @Firbydude made their first contribution in https://github.com/elizaOS/eliza/pull/1442
* @MonteCrypto999 made their first contribution in https://github.com/elizaOS/eliza/pull/2249
* @lincheoll made their first contribution in https://github.com/elizaOS/eliza/pull/2274
* @jason51553262 made their first contribution in https://github.com/elizaOS/eliza/pull/2267
* @CryptoGraffe made their first contribution in https://github.com/elizaOS/eliza/pull/2307
* @bbopar made their first contribution in https://github.com/elizaOS/eliza/pull/2293
* @hellopleasures made their first contribution in https://github.com/elizaOS/eliza/pull/1865
* @chuasonglin1995 made their first contribution in https://github.com/elizaOS/eliza/pull/2195
* @everimbaq made their first contribution in https://github.com/elizaOS/eliza/pull/2324
* @derrekcoleman made their first contribution in https://github.com/elizaOS/eliza/pull/2336
* @sukrucildirr made their first contribution in https://github.com/elizaOS/eliza/pull/2334
* @C0ldSmi1e made their first contribution in https://github.com/elizaOS/eliza/pull/2353
* @0xnogo made their first contribution in https://github.com/elizaOS/eliza/pull/2149
* @leeran7 made their first contribution in https://github.com/elizaOS/eliza/pull/2328
* @defitricks made their first contribution in https://github.com/elizaOS/eliza/pull/2370
* @0xSero made their first contribution in https://github.com/elizaOS/eliza/pull/2378
* @dev-whoan made their first contribution in https://github.com/elizaOS/eliza/pull/2382
* @ericlehong made their first contribution in https://github.com/elizaOS/eliza/pull/2385
* @crStiv made their first contribution in https://github.com/elizaOS/eliza/pull/2394
* @francis2tm made their first contribution in https://github.com/elizaOS/eliza/pull/2082
* @enigmarikki made their first contribution in https://github.com/elizaOS/eliza/pull/1764
* @sweetmantech made their first contribution in https://github.com/elizaOS/eliza/pull/2298
* @donatik27 made their first contribution in https://github.com/elizaOS/eliza/pull/2438
* @leopardracer made their first contribution in https://github.com/elizaOS/eliza/pull/2435
* @Hopium21 made their first contribution in https://github.com/elizaOS/eliza/pull/2441
* @bundinho made their first contribution in https://github.com/elizaOS/eliza/pull/2415
* @RubinovaAn1097 made their first contribution in https://github.com/elizaOS/eliza/pull/2449
* @MarsonKotovi4 made their first contribution in https://github.com/elizaOS/eliza/pull/2445
* @ae9is made their first contribution in https://github.com/elizaOS/eliza/pull/2375
* @Pistasha made their first contribution in https://github.com/elizaOS/eliza/pull/2447
* @dedyshkaPexto made their first contribution in https://github.com/elizaOS/eliza/pull/2464
* @Dimitrolito made their first contribution in https://github.com/elizaOS/eliza/pull/2456
* @carlos-cne made their first contribution in https://github.com/elizaOS/eliza/pull/2413
* @suleigolden made their first contribution in https://github.com/elizaOS/eliza/pull/2462
* @B1boid made their first contribution in https://github.com/elizaOS/eliza/pull/2332
* @lispking made their first contribution in https://github.com/elizaOS/eliza/pull/2476
* @Olexandr88 made their first contribution in https://github.com/elizaOS/eliza/pull/2483
* @sunsakis made their first contribution in https://github.com/elizaOS/eliza/pull/2340
* @Daulox92 made their first contribution in https://github.com/elizaOS/eliza/pull/2495
* @KoZivod88074 made their first contribution in https://github.com/elizaOS/eliza/pull/2485
* @tercel made their first contribution in https://github.com/elizaOS/eliza/pull/2365
* @0xrubusdata made their first contribution in https://github.com/elizaOS/eliza/pull/2463
* @visionpixel made their first contribution in https://github.com/elizaOS/eliza/pull/2518
* @Haisen772 made their first contribution in https://github.com/elizaOS/eliza/pull/2492
* @bfontes made their first contribution in https://github.com/elizaOS/eliza/pull/2506
* @jimtracy1007 made their first contribution in https://github.com/elizaOS/eliza/pull/2429
* @devin-ai-integration made their first contribution in https://github.com/elizaOS/eliza/pull/2549
* @neelkanani made their first contribution in https://github.com/elizaOS/eliza/pull/2547
* @BitWonka made their first contribution in https://github.com/elizaOS/eliza/pull/2524
* @maxcoto made their first contribution in https://github.com/elizaOS/eliza/pull/2389
* @cuongnguyenthai made their first contribution in https://github.com/elizaOS/eliza/pull/2596
* @leejw51crypto made their first contribution in https://github.com/elizaOS/eliza/pull/2585
* @RaveenaBhasin made their first contribution in https://github.com/elizaOS/eliza/pull/2590
* @boohyunsik made their first contribution in https://github.com/elizaOS/eliza/pull/2448
* @brkagithub made their first contribution in https://github.com/elizaOS/eliza/pull/2380
* @stanislawkurzypBD made their first contribution in https://github.com/elizaOS/eliza/pull/2554
* @siphonelee made their first contribution in https://github.com/elizaOS/eliza/pull/2654
* @jteso made their first contribution in https://github.com/elizaOS/eliza/pull/2645
* @nnsW3 made their first contribution in https://github.com/elizaOS/eliza/pull/2669
* @VolodymyrBg made their first contribution in https://github.com/elizaOS/eliza/pull/2672
* @lxcong made their first contribution in https://github.com/elizaOS/eliza/pull/2162
* @dtbuchholz made their first contribution in https://github.com/elizaOS/eliza/pull/2176
* @simsaidev made their first contribution in https://github.com/elizaOS/eliza/pull/2618
* @oxf71 made their first contribution in https://github.com/elizaOS/eliza/pull/2322
* @OmniflixBlockEater made their first contribution in https://github.com/elizaOS/eliza/pull/2693
* @bealers made their first contribution in https://github.com/elizaOS/eliza/pull/2698
* @Evan-zkLinkLabs made their first contribution in https://github.com/elizaOS/eliza/pull/2659
* @worksgoodcompany made their first contribution in https://github.com/elizaOS/eliza/pull/2686
* @klren0312 made their first contribution in https://github.com/elizaOS/eliza/pull/2748
* @dezcalimese made their first contribution in https://github.com/elizaOS/eliza/pull/2703
* @dev-holdstation made their first contribution in https://github.com/elizaOS/eliza/pull/2741
* @alex1092 made their first contribution in https://github.com/elizaOS/eliza/pull/2736
* @mj850 made their first contribution in https://github.com/elizaOS/eliza/pull/2720
* @guspan-tanadi made their first contribution in https://github.com/elizaOS/eliza/pull/2724
* @ajkraus04 made their first contribution in https://github.com/elizaOS/eliza/pull/2755
* @krustevalexander made their first contribution in https://github.com/elizaOS/eliza/pull/2711
* @iteyelmp made their first contribution in https://github.com/elizaOS/eliza/pull/2737
* @ebaizel made their first contribution in https://github.com/elizaOS/eliza/pull/2769
* @LouisVannobel made their first contribution in https://github.com/elizaOS/eliza/pull/2763
* @pranav-singhal made their first contribution in https://github.com/elizaOS/eliza/pull/2766
* @bharathbabu-moralis made their first contribution in https://github.com/elizaOS/eliza/pull/2764
* @ccross2 made their first contribution in https://github.com/elizaOS/eliza/pull/2687
* @LinuxIsCool made their first contribution in https://github.com/elizaOS/eliza/pull/2632
* @Cooops made their first contribution in https://github.com/elizaOS/eliza/pull/2709
* @tmarwen made their first contribution in https://github.com/elizaOS/eliza/pull/2728
* @benliang99 made their first contribution in https://github.com/elizaOS/eliza/pull/2682
* @Liao1 made their first contribution in https://github.com/elizaOS/eliza/pull/2638
* @KanishkKhurana made their first contribution in https://github.com/elizaOS/eliza/pull/2631
* @batudo made their first contribution in https://github.com/elizaOS/eliza/pull/2616
* @jobyid made their first contribution in https://github.com/elizaOS/eliza/pull/1427
* @AdventureSeeker987 made their first contribution in https://github.com/elizaOS/eliza/pull/2781
* @brandon1525 made their first contribution in https://github.com/elizaOS/eliza/pull/2564
* @zy-bc-ai made their first contribution in https://github.com/elizaOS/eliza/pull/2431
* @Alirun made their first contribution in https://github.com/elizaOS/eliza/pull/2725
* @JhChoy made their first contribution in https://github.com/elizaOS/eliza/pull/2789
* @juanc07 made their first contribution in https://github.com/elizaOS/eliza/pull/2782
* @calintje made their first contribution in https://github.com/elizaOS/eliza/pull/2136
* @elpulpo0 made their first contribution in https://github.com/elizaOS/eliza/pull/2810
* @actuallyrizzn made their first contribution in https://github.com/elizaOS/eliza/pull/2812
* @rubinovitz made their first contribution in https://github.com/elizaOS/eliza/pull/2821
* @anirudhmakhana made their first contribution in https://github.com/elizaOS/eliza/pull/2799
* @Nevermore-Ray made their first contribution in https://github.com/elizaOS/eliza/pull/2797
* @humanagent made their first contribution in https://github.com/elizaOS/eliza/pull/2786
* @AmriteshTrikon made their first contribution in https://github.com/elizaOS/eliza/pull/2653
* @rrw-zilliqa made their first contribution in https://github.com/elizaOS/eliza/pull/2842
* @tgaru made their first contribution in https://github.com/elizaOS/eliza/pull/2839
* @fifahuihua made their first contribution in https://github.com/elizaOS/eliza/pull/2794
* @mmarfinetz made their first contribution in https://github.com/elizaOS/eliza/pull/2784
* @stopmalone made their first contribution in https://github.com/elizaOS/eliza/pull/1238
* @viv-cheung made their first contribution in https://github.com/elizaOS/eliza/pull/2644
* @maximevtush made their first contribution in https://github.com/elizaOS/eliza/pull/2903
* @Pricstas made their first contribution in https://github.com/elizaOS/eliza/pull/2909
* @michavie made their first contribution in https://github.com/elizaOS/eliza/pull/2932
* @eric2hen made their first contribution in https://github.com/elizaOS/eliza/pull/2913
* @wonseokjung made their first contribution in https://github.com/elizaOS/eliza/pull/2950
* @derrix060 made their first contribution in https://github.com/elizaOS/eliza/pull/2975
* @yaruno made their first contribution in https://github.com/elizaOS/eliza/pull/2987
* @Dahka2321 made their first contribution in https://github.com/elizaOS/eliza/pull/2921
* @futreall made their first contribution in https://github.com/elizaOS/eliza/pull/2986
* @madschristensen99 made their first contribution in https://github.com/elizaOS/eliza/pull/2912
* @YohanGH made their first contribution in https://github.com/elizaOS/eliza/pull/2964
* @maxime made their first contribution in https://github.com/elizaOS/eliza/pull/3006
* @Jesscha made their first contribution in https://github.com/elizaOS/eliza/pull/3018
* @sky-coderay made their first contribution in https://github.com/elizaOS/eliza/pull/3041
* @tobySolutions made their first contribution in https://github.com/elizaOS/eliza/pull/3048
* @PhyByte made their first contribution in https://github.com/elizaOS/eliza/pull/3026
* @EmanHerawy made their first contribution in https://github.com/elizaOS/eliza/pull/3081
* @MichaelDeng03 made their first contribution in https://github.com/elizaOS/eliza/pull/3050
* @akugone made their first contribution in https://github.com/elizaOS/eliza/pull/3118
</details>

#### Full Changelog: https://github.com/elizaOS/eliza/compare/v0.1.8-alpha.1...v0.1.9

---

## v0.1.8 (January 12, 2025)

#### What's Changed

#### Features

- TTS (Text2Speech) with over 15 languages support! #2110
- Image descriptions into client-twitter #1775
- Add Heurist embedding model #2093
- Add Cloudflare AI Gateway support #821
- Add Mistral AI as new model provider #2137
- Add DeepSeek AI provider support to Eliza #2067
- Support TEE logging and support running eliza in Intel SGX #1470
- Pro API support, trending coins API #2068
- Add Irys plugin #1708
- Add support autonome platform #2121
- Add Akash Network plugin with autonomous deployment capabilities #2111
- Add Lens Network Plugin #2101
- Add plugin-hyperliquid #2141
- Add asterai plugin #2045
- Add massa-plugin #1582
- Add Quai integration #2083
- Primus zkTLS plugin to fully verify agent activities #2086
- Solana transaction more lenient (wait for confirmed instead of finalized) #2053

#### Fixes

- Fix plugin loading from a character.json file #2095
- prevent repeated login by reusing client-twitter session #2129
- fix the chat stuck in infinite loop #1755
- fix client-discord join voice action #2160
- replace invalid together ai medium model #2173
- insert missing langdetect on plugin-tts package.json #2175
- Apply model settings for images and remove duplicate files #2118
- clientConfig.telegram.isPartOfTeam mistype #2103
- fix starknet plugin by replacing walletProvider with portfolio provider #2029
- correct SUI/USD price calculation #2150
- deepseek support in getTokenForProvider #2179
- Supabase updates #2100
- Koloxarto/fix ragknowledge for postgres #2153
- case-sensitive column reference in knowledge table CHECK constraint #2058
- syntax issue on autonome plugin and lock file update #2131
- lens export name and duplicate imports #2142
- Revert "feat: Proof of Pizza - Agentic Dominos Ordering" #2075

Complete changelog:
* fix: add default export to plugin-image-generation by @jonathanmv in https://github.com/elizaOS/eliza/pull/1831
* Update .env.example by @bitcoinbender in https://github.com/elizaOS/eliza/pull/1829
* chore: update develop from main by @shakkernerd in https://github.com/elizaOS/eliza/pull/1823
* feat(models): update Google model configurations by @gmh5225 in https://github.com/elizaOS/eliza/pull/1815
* improvement: replacing console.log with elizaLogger by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/1834
* Update README_KOR.md by @web3isthefuture in https://github.com/elizaOS/eliza/pull/1835
* refactor: typo in readme by @MagikHolder in https://github.com/elizaOS/eliza/pull/1832
* Fix faq link on contributing.md by @manotoor in https://github.com/elizaOS/eliza/pull/1847
* Create README.md by @RobertSloan22 in https://github.com/elizaOS/eliza/pull/1787
* Update c3po.character.json by @macfly-base in https://github.com/elizaOS/eliza/pull/1827
* Feat/genlayer plugin by @AgustinRamiroDiaz in https://github.com/elizaOS/eliza/pull/975
* fix: broken ci docs missed frozen pnpm file out-of-sync by @marcellodesales in https://github.com/elizaOS/eliza/pull/1798
* chore: update bootstrap plugin export by @affaan-m in https://github.com/elizaOS/eliza/pull/1836
* correct faq docs link in both contribution md files by @MacsDickinson in https://github.com/elizaOS/eliza/pull/1839
* Feat: add infera as an inference provide by @inferanetwork in https://github.com/elizaOS/eliza/pull/1860
* feat: add avail plugin by @robin-rrt in https://github.com/elizaOS/eliza/pull/1241
* feat: Add Stargaze plugin by @daniel-farina in https://github.com/elizaOS/eliza/pull/1861
* feat: add cosmos plugin  by @mgacek-blockydevs in https://github.com/elizaOS/eliza/pull/1826
* feat: Implement a plugin that can retrieve Marlin TEE remote attestations by @roshanrags in https://github.com/elizaOS/eliza/pull/935
* docs: Add DAO donation ask & dev discord by @odilitime in https://github.com/elizaOS/eliza/pull/1867
* fix: Fix postinstall script by @odilitime in https://github.com/elizaOS/eliza/pull/1872
* docs: add Romanian README translation by @pedronovikovborges in https://github.com/elizaOS/eliza/pull/1770
* test: adding more tests for goals,memory and provider. Fixing generation.test.ts by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/1840
* fix: remove twitter profile caching (#1638) by @augchan42 in https://github.com/elizaOS/eliza/pull/1782
* feat: Add devcontainer by @jazzvaz in https://github.com/elizaOS/eliza/pull/1807
* fix(solana token provider): await cached data by @bentatum in https://github.com/elizaOS/eliza/pull/1828
* chore: support more debians distros by @odilitime in https://github.com/elizaOS/eliza/pull/1875
* feat: refactor model config by @tcm390 in https://github.com/elizaOS/eliza/pull/1805
* feat: added new plugin - zktls - reclaim by @Gajesh2007 in https://github.com/elizaOS/eliza/pull/1558
* Feat: Support wildcard in TWITTER_TARGET_USERS 1883 by @augchan42 in https://github.com/elizaOS/eliza/pull/1884
* feat: add remote attestation action by @HashWarlock in https://github.com/elizaOS/eliza/pull/1885
* feat: Use recommended settings in jupiter swap by @Arrowana in https://github.com/elizaOS/eliza/pull/1882
* Fixed broken API Documentation URL by @JoeyKhd in https://github.com/elizaOS/eliza/pull/1881
* feat: add OpenWeather plugin by @kylebuildsstuff in https://github.com/elizaOS/eliza/pull/1880
* test: adding test setup for telegram client by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/1879
* chore(core): enable strict null checks by @bentatum in https://github.com/elizaOS/eliza/pull/1878
* fix: remove case sensitive path by @zhourunlai in https://github.com/elizaOS/eliza/pull/1892
* feat: hyperfy support by @odilitime in https://github.com/elizaOS/eliza/pull/1896
* Add Dutch (Nederlands) translation by @xzrfax in https://github.com/elizaOS/eliza/pull/1909
* fix: twitter result obj undefined properties by @zhourunlai in https://github.com/elizaOS/eliza/pull/1905
* chore: fix integrations and smoke tests by @shakkernerd in https://github.com/elizaOS/eliza/pull/1893
* fix: add callback to the evaluators for client-telegram by @RatakondalaArun in https://github.com/elizaOS/eliza/pull/1908
* chore(client-discord): fix SUMMARIZE prompt  by @bodhi-crypo in https://github.com/elizaOS/eliza/pull/1916
* fix(core): check evaluators for null by @bentatum in https://github.com/elizaOS/eliza/pull/1918
* fix: resolved a bunch of type related errors and ensure project compiles by @JoeyKhd in https://github.com/elizaOS/eliza/pull/1917
* feats: diagram update by @tomguluson92 in https://github.com/elizaOS/eliza/pull/1907
* feat: Optimize Agent Action Processing by Prioritizing Timelines and Limiting Actions Per Cycle by @tcm390 in https://github.com/elizaOS/eliza/pull/1824
* Feature/add binance plugin by @Lukapetro in https://github.com/elizaOS/eliza/pull/1812
* Fix typo Update CHANGELOG.md by @petryshkaCODE in https://github.com/elizaOS/eliza/pull/1922
* feat: add GoPlus Security Plugin to enhance security for agent by @0xbeekeeper in https://github.com/elizaOS/eliza/pull/1898
* API route update by @JoeyKhd in https://github.com/elizaOS/eliza/pull/1923
* fix: handle empty input text to avoid memory content empty error by @zhourunlai in https://github.com/elizaOS/eliza/pull/1919
* test: adding tests for discord-client by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/1927
* docs: Add "What Did You Get Done This Week? #8" notes by @YoungPhlo in https://github.com/elizaOS/eliza/pull/1894
* fix: Limit the number of timelines fetched by @tcm390 in https://github.com/elizaOS/eliza/pull/1931
* fix: rm unused variable X_SERVER_URL by @proteanx in https://github.com/elizaOS/eliza/pull/1930
* feat: Make templates in composeContext dynamic by @jonathangus in https://github.com/elizaOS/eliza/pull/1467
* docs: it is processAction instead of triggerAction by @threewebcode in https://github.com/elizaOS/eliza/pull/1937
* feat: solana token deploy using solana agent kit by @renlulu in https://github.com/elizaOS/eliza/pull/1373
* chore(plugin-conflux): remove unused imports by @bendanzhentan in https://github.com/elizaOS/eliza/pull/1941
* feat(plugin-cronoszkevm): rm not used imports by @sinecose in https://github.com/elizaOS/eliza/pull/1744
* feat: support for eternalai provider can make request with chain_id extra data in body by @genesis-0000 in https://github.com/elizaOS/eliza/pull/1938
* chore: more specific rpc urls by @0xRider in https://github.com/elizaOS/eliza/pull/1945
* feat: support for eternalai provider can write request/response log info by @genesis-0000 in https://github.com/elizaOS/eliza/pull/1948
* chore: add embedding tests by @shlokkhemani in https://github.com/elizaOS/eliza/pull/1944
* feat: new plugin Arthera Chain by @elpiarthera in https://github.com/elizaOS/eliza/pull/1818
* fix: fixed error in C3PO and improved error handling feedback by @JoeyKhd in https://github.com/elizaOS/eliza/pull/1951
* feat: add pglite db adapter by @KONFeature in https://github.com/elizaOS/eliza/pull/1810
* feat: Add fraxtal chain to evm by @kesar in https://github.com/elizaOS/eliza/pull/1954
* feat: add coin price plugin (CoinMarketCap, CoinGecko & CoinCap) by @proteanx in https://github.com/elizaOS/eliza/pull/1808
* fix: abstract readme by @cygaar in https://github.com/elizaOS/eliza/pull/1963
* feat: improve twitter paragraph splitting if containing url by @darwintree in https://github.com/elizaOS/eliza/pull/1947
* test: adding tests for twitter-client by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/1959
* test: adding tests for twitter plugin by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/1976
* chore: Cleaner logs on agent startup by @velvet-shark in https://github.com/elizaOS/eliza/pull/1973
* feat: anyone plugin to privatise network requests  by @Saundr21 in https://github.com/elizaOS/eliza/pull/1960
* fix: SQLITE ERROR, zero-lenght vectors not supported by @JoeyKhd in https://github.com/elizaOS/eliza/pull/1984
* fix: many fixes to the Telegram templates by @Laurentiu-Andronache in https://github.com/elizaOS/eliza/pull/1982
* test: changing test structure for core package. Fixing failling outdated tests by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/1989
* chore: Enable all EVM chains by default by @Minco-Yuga in https://github.com/elizaOS/eliza/pull/1981
* chore: add debug logging for context by @Laurentiu-Andronache in https://github.com/elizaOS/eliza/pull/1980
* fix: Fix db init race condition affecting builds by @0x-jj in https://github.com/elizaOS/eliza/pull/1968
* feat: add new plugin - spheron by @rekpero in https://github.com/elizaOS/eliza/pull/1966
* feat: Add Allora plugin by @conache in https://github.com/elizaOS/eliza/pull/1955
* fix: Added Local Embedding Manager to reuse Local embed model - Fixes High Ram Issues by @mbcse in https://github.com/elizaOS/eliza/pull/1950
* feat: obsidian integration plugin by @sekmet in https://github.com/elizaOS/eliza/pull/1943
* add thirdweb plugin by @iankm in https://github.com/elizaOS/eliza/pull/1418
* feat: improvements for plugin-cosmos by @mgacek-blockydevs in https://github.com/elizaOS/eliza/pull/1934
* fix: build on plugin spheron by @shakkernerd in https://github.com/elizaOS/eliza/pull/1995
* fix: client twitter dryrun by @tcm390 in https://github.com/elizaOS/eliza/pull/1997
* fix: resolve translation type issue by @odilitime in https://github.com/elizaOS/eliza/pull/1996
* fix: fix .env.sample defaults by @odilitime in https://github.com/elizaOS/eliza/pull/1999
* chore: update website url in lore.md by @tomguluson92 in https://github.com/elizaOS/eliza/pull/1998
* Add support for Movement Network by @Rahat-ch in https://github.com/elizaOS/eliza/pull/1621
* docs: Optimizes Technical Docs for LLMs & Vectorization by @Ed-Marcavage in https://github.com/elizaOS/eliza/pull/1993
* feat: Separate Knowledge system + Multi-Agent RAG Optimization by @azep-ninja in https://github.com/elizaOS/eliza/pull/1620
* feat: implement getKnowledge, searchKnowledge, createKnowledge, removeKnowledge and clearKnowledge methods by @shakkernerd in https://github.com/elizaOS/eliza/pull/2005
* chore: Make `generateNewTweet` public by @hazelnutcloud in https://github.com/elizaOS/eliza/pull/1902
* fix: remove legacy variables (XAI_MODEL,  XAI_API_KEY & IMAGE_GEN) by @proteanx in https://github.com/elizaOS/eliza/pull/2001
* Update plugins.md -- Allora README Fix by @kush-alloralabs in https://github.com/elizaOS/eliza/pull/2003
* update: Readme and Comments by @rferrari in https://github.com/elizaOS/eliza/pull/2006
* fix: Auto Client bug by @HashWarlock in https://github.com/elizaOS/eliza/pull/2007
* chore(plugin-solana): replace console with elizaLogger by @sinecose in https://github.com/elizaOS/eliza/pull/1888
* feat: make the birdeye api req optional by @kamalbuilds in https://github.com/elizaOS/eliza/pull/1895
* feat: init DePIN plugin by @nicky-ru in https://github.com/elizaOS/eliza/pull/1874
* fix: packages/adapter-postgres/schema.sql isShared needs double quote by @koofree in https://github.com/elizaOS/eliza/pull/2008
* feat: Add approval mechanism for Twitter posts via Discord bot by @mbcse in https://github.com/elizaOS/eliza/pull/1876
* feat: Giphy plugin - Add animated gif to conversations by @daniel-farina in https://github.com/elizaOS/eliza/pull/1873
* Opacity Verifiable Interference zkTLS Plugin by @RonTuretzky in https://github.com/elizaOS/eliza/pull/1673
* fix: remove near-solana slippage env conflict by @wtfsayo in https://github.com/elizaOS/eliza/pull/2016
* feat: Update the Galadriel LLM integration to reflect their product updates by @kristjanpeterson1 in https://github.com/elizaOS/eliza/pull/2011
* chore(ci): add pnpm lockfile consistency check workflow by @jonathanykh in https://github.com/elizaOS/eliza/pull/2015
* feat: add telegram api root config in env by @dto-simba in https://github.com/elizaOS/eliza/pull/2014
* feat: new plugin LetzAI by @mitchoz in https://github.com/elizaOS/eliza/pull/1868
* fix: letzAi build issues by @wtfsayo in https://github.com/elizaOS/eliza/pull/2021
* feat: plugin new RabbiTrader by @Freytes in https://github.com/elizaOS/eliza/pull/1785
* Feature/add coinmarketcap plugin by @Lukapetro in https://github.com/elizaOS/eliza/pull/1773
* fix: remove defillama plugin & improve rabbi trader by @wtfsayo in https://github.com/elizaOS/eliza/pull/2027
* Update README_RU.md by @WAGMIBRO in https://github.com/elizaOS/eliza/pull/2026
* Update .env.example by @antman1p in https://github.com/elizaOS/eliza/pull/2031
* fix: include schema.sql and seed.sql in package files by @brauliolomeli in https://github.com/elizaOS/eliza/pull/2030
* fix: 🚚 📚 move plugin-web-search readme to root dir by @marcellodesales in https://github.com/elizaOS/eliza/pull/1992
* feat: full overhaul of client by @JoeyKhd in https://github.com/elizaOS/eliza/pull/2038
* fix: update slack client readme manifest by @AnonJon in https://github.com/elizaOS/eliza/pull/2044
* fix: Update Key Derive in TEE by @HashWarlock in https://github.com/elizaOS/eliza/pull/2039
* Revert "fix: Update Key Derive in TEE" by @shakkernerd in https://github.com/elizaOS/eliza/pull/2049
* fix: Categorize & Format .env.example by @proteanx in https://github.com/elizaOS/eliza/pull/2052
* fix: update regex to allow Unicode characters in message processing by @taofengno1 in https://github.com/elizaOS/eliza/pull/2048
* Fix: more specific rpc urls by @zhourunlai in https://github.com/elizaOS/eliza/pull/2018
* feat: Proof of Pizza - Agentic Dominos Ordering by @bayological in https://github.com/elizaOS/eliza/pull/2042
* Feature/plugin coingecko by @Lukapetro in https://github.com/elizaOS/eliza/pull/1761
* feat: improve zkstack based plugins by @aalimsahin in https://github.com/elizaOS/eliza/pull/1821
* feat: added nineteen.ai llm & image support by @tripathiarpan20 in https://github.com/elizaOS/eliza/pull/2022
* feat: plugin-nft-generation support evm chain by @xwxtwd in https://github.com/elizaOS/eliza/pull/1763
* fix: Bugfix in LetzAI Plugin -> missing named export and Plugin-type by @DanielWahl in https://github.com/elizaOS/eliza/pull/2062
* Galadriel docs and .env.example update by @kristjanpeterson1 in https://github.com/elizaOS/eliza/pull/2061
* fix: PGVector_embedding_validation (#1687)  by @AIFlowML in https://github.com/elizaOS/eliza/pull/1750
* fix: fix multiversx-plugin by @mgavrila in https://github.com/elizaOS/eliza/pull/2017
* revert: #2048 by @wtfsayo in https://github.com/elizaOS/eliza/pull/2059
* feat: support TEE logging and support running eliza in Intel SGX by @ShuochengWang in https://github.com/elizaOS/eliza/pull/1470
* Update README_CN to match latest English README by @bxngxl in https://github.com/elizaOS/eliza/pull/2069
* Fix: case-sensitive column reference in knowledge table CHECK constraint by @antman1p in https://github.com/elizaOS/eliza/pull/2058
* docs: Update README_KOR.md by @YANGSEOKWOO in https://github.com/elizaOS/eliza/pull/2074
* fix: Revert "feat: Proof of Pizza - Agentic Dominos Ordering" by @tcm390 in https://github.com/elizaOS/eliza/pull/2075
* fix: rm unused imports by @mameikagou in https://github.com/elizaOS/eliza/pull/2112
* chore: revert #1808 + add missing import for coin gecko plugin by @wtfsayo in https://github.com/elizaOS/eliza/pull/2106
* Add name and description to SttTtsPlugin  by @mameikagou in https://github.com/elizaOS/eliza/pull/2117
* fix: Apply model settings for images and remove duplicate files by @tcm390 in https://github.com/elizaOS/eliza/pull/2118
* feat: pro api support, trending coins api by @Lukapetro in https://github.com/elizaOS/eliza/pull/2068
* Add gemini to image vision by @web3gh in https://github.com/elizaOS/eliza/pull/2099
* feat: Add Irys plugin by @Hugo-SEQUIER in https://github.com/elizaOS/eliza/pull/1708
* fix: Fix plugin loading from a character.json file by @treppers in https://github.com/elizaOS/eliza/pull/2095
* feat: add Heurist embedding model by @tsubasakong in https://github.com/elizaOS/eliza/pull/2093
* fix: clientConfig.telegram.isPartOfTeam mistype by @rferrari in https://github.com/elizaOS/eliza/pull/2103
* docs: Add Verified Inference docs by @maciejwitowski in https://github.com/elizaOS/eliza/pull/2125
* fix: Update clients.md to fix package name by @prasadabhishek in https://github.com/elizaOS/eliza/pull/2091
* feat: support autonome platform by @autonome-ai in https://github.com/elizaOS/eliza/pull/2121
* fix: syntax issue on autonome plugin and lock file update by @wtfsayo in https://github.com/elizaOS/eliza/pull/2131
* test: Integration Tests Enhancement and Coinbase Commerce Integration by @pgoos in https://github.com/elizaOS/eliza/pull/1767
* fix: prevent repeated login by reusing client-twitter session by @tcm390 in https://github.com/elizaOS/eliza/pull/2129
* fix: update lockfile and fix lint findings by @odilitime in https://github.com/elizaOS/eliza/pull/2128
* feat: Add Akash Network plugin with autonomous deployment capabilities by @AIFlowML in https://github.com/elizaOS/eliza/pull/2111
* feat: Lens Network Plugin by @pranjallyad in https://github.com/elizaOS/eliza/pull/2101
* Docs improvements by @tudorpintea999 in https://github.com/elizaOS/eliza/pull/2138
* fix: lens export name and duplicate imports by @tcm390 in https://github.com/elizaOS/eliza/pull/2142
* Fix: Supabase updates by @antman1p in https://github.com/elizaOS/eliza/pull/2100
* refactor: Optimize memory fetching by moving sorting and slicing to DB (PR #1531 remake) by @odilitime in https://github.com/elizaOS/eliza/pull/2135
* feat: Add Cloudflare AI Gateway support by @w3-bounty in https://github.com/elizaOS/eliza/pull/821
* docs: add readme portuguese version in docs by @rRogick in https://github.com/elizaOS/eliza/pull/2088
* fix: eslint-fix-full-test-again by @AIFlowML in https://github.com/elizaOS/eliza/pull/2143
* Fix: fix starknet plugin by replacing walletProvider with portfolio provider by @Jonatan-Chaverri in https://github.com/elizaOS/eliza/pull/2029
* feat: Image descriptions into interaction.ts by @denizekiz in https://github.com/elizaOS/eliza/pull/1775
* feat: plugin-hyperliquid by @earlyvibz in https://github.com/elizaOS/eliza/pull/2141
* feat: Add Mistral AI as new model provider by @brauliolomeli in https://github.com/elizaOS/eliza/pull/2137
* feat: Implement asterai plugin by @rellfy in https://github.com/elizaOS/eliza/pull/2045
* feat: add massa-plugin by @peterjah in https://github.com/elizaOS/eliza/pull/1582
* feat: add Quai integration by @0xalank in https://github.com/elizaOS/eliza/pull/2083
* feat: Add DeepSeek AI provider support to Eliza by @daizhengxue in https://github.com/elizaOS/eliza/pull/2067
* feat: Primus zkTLS plugin to fully verify agent activities by @xiangxiecrypto in https://github.com/elizaOS/eliza/pull/2086
* fix: fix client-discord join voice action by @tcm390 in https://github.com/elizaOS/eliza/pull/2160
* add github to client enumerations by @AnonJon in https://github.com/elizaOS/eliza/pull/2157
* inheritance of character from parent using extends key by @ShreyGanatra in https://github.com/elizaOS/eliza/pull/2159
* fix: correct SUI/USD price calculation by @ChainRex in https://github.com/elizaOS/eliza/pull/2150
* feat: solana transaction more lenient by @zhourunlai in https://github.com/elizaOS/eliza/pull/2053
* chore: Add UUID tests and fix version 5 bits by @shlokkhemani in https://github.com/elizaOS/eliza/pull/1362
* Update git command for checking latest release by @velvet-shark in https://github.com/elizaOS/eliza/pull/1705
* chore: add conditionals for supabase to agent directory by @antman1p in https://github.com/elizaOS/eliza/pull/2032
* chore: bump develop lockfile by @odilitime in https://github.com/elizaOS/eliza/pull/2166
* feat: TTS(Text2Speech) with over 15 languages support! by @tomguluson92 in https://github.com/elizaOS/eliza/pull/2110
* test: moving uuid.tests to correct __tests__ directory by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2168
* tests: coinbase plugin - adding tests for coinbase plugin by @ai16z-demirix in https://github.com/elizaOS/eliza/pull/2170
* Fix: replace invalid together ai medium model by @Jonatan-Chaverri in https://github.com/elizaOS/eliza/pull/2173
* fix: insert missing langdetect on plugin-tts package.json by @rferrari in https://github.com/elizaOS/eliza/pull/2175
* fix(client-twitter): add mention deduplication utility by @nhodges in https://github.com/elizaOS/eliza/pull/2178
* feat: 🎈 perf(vscode): Set file nesting for md and DockerFile by @AAAkater in https://github.com/elizaOS/eliza/pull/2177
* fix: deepseek support in getTokenForProvider by @Riroaki in https://github.com/elizaOS/eliza/pull/2179
* fix: remove problematic redundant uuid conversion and add api input param validations to api server by @jonathanykh in https://github.com/elizaOS/eliza/pull/2051
* fix: fix the chat stuck in infinite loop by @zoe27 in https://github.com/elizaOS/eliza/pull/1755
* fix: Koloxarto/fix ragknowledge for postgres by @web3gh in https://github.com/elizaOS/eliza/pull/2153
* chore: lint and fix pass on develop by @odilitime in https://github.com/elizaOS/eliza/pull/2180
* chore: Prep v0.1.8 (dev => main) by @odilitime in https://github.com/elizaOS/eliza/pull/2171

#### New Contributors

<details>
<summary>View New Contributors</summary>
* @jonathanmv made their first contribution in https://github.com/elizaOS/eliza/pull/1831
* @bitcoinbender made their first contribution in https://github.com/elizaOS/eliza/pull/1829
* @web3isthefuture made their first contribution in https://github.com/elizaOS/eliza/pull/1835
* @MagikHolder made their first contribution in https://github.com/elizaOS/eliza/pull/1832
* @manotoor made their first contribution in https://github.com/elizaOS/eliza/pull/1847
* @RobertSloan22 made their first contribution in https://github.com/elizaOS/eliza/pull/1787
* @macfly-base made their first contribution in https://github.com/elizaOS/eliza/pull/1827
* @AgustinRamiroDiaz made their first contribution in https://github.com/elizaOS/eliza/pull/975
* @MacsDickinson made their first contribution in https://github.com/elizaOS/eliza/pull/1839
* @inferanetwork made their first contribution in https://github.com/elizaOS/eliza/pull/1860
* @robin-rrt made their first contribution in https://github.com/elizaOS/eliza/pull/1241
* @daniel-farina made their first contribution in https://github.com/elizaOS/eliza/pull/1861
* @mgacek-blockydevs made their first contribution in https://github.com/elizaOS/eliza/pull/1826
* @roshanrags made their first contribution in https://github.com/elizaOS/eliza/pull/935
* @pedronovikovborges made their first contribution in https://github.com/elizaOS/eliza/pull/1770
* @jazzvaz made their first contribution in https://github.com/elizaOS/eliza/pull/1807
* @bentatum made their first contribution in https://github.com/elizaOS/eliza/pull/1828
* @Gajesh2007 made their first contribution in https://github.com/elizaOS/eliza/pull/1558
* @Arrowana made their first contribution in https://github.com/elizaOS/eliza/pull/1882
* @JoeyKhd made their first contribution in https://github.com/elizaOS/eliza/pull/1881
* @kylebuildsstuff made their first contribution in https://github.com/elizaOS/eliza/pull/1880
* @xzrfax made their first contribution in https://github.com/elizaOS/eliza/pull/1909
* @RatakondalaArun made their first contribution in https://github.com/elizaOS/eliza/pull/1908
* @bodhi-crypo made their first contribution in https://github.com/elizaOS/eliza/pull/1916
* @petryshkaCODE made their first contribution in https://github.com/elizaOS/eliza/pull/1922
* @0xbeekeeper made their first contribution in https://github.com/elizaOS/eliza/pull/1898
* @threewebcode made their first contribution in https://github.com/elizaOS/eliza/pull/1937
* @shlokkhemani made their first contribution in https://github.com/elizaOS/eliza/pull/1944
* @elpiarthera made their first contribution in https://github.com/elizaOS/eliza/pull/1818
* @KONFeature made their first contribution in https://github.com/elizaOS/eliza/pull/1810
* @kesar made their first contribution in https://github.com/elizaOS/eliza/pull/1954
* @velvet-shark made their first contribution in https://github.com/elizaOS/eliza/pull/1973
* @Saundr21 made their first contribution in https://github.com/elizaOS/eliza/pull/1960
* @Laurentiu-Andronache made their first contribution in https://github.com/elizaOS/eliza/pull/1982
* @Minco-Yuga made their first contribution in https://github.com/elizaOS/eliza/pull/1981
* @0x-jj made their first contribution in https://github.com/elizaOS/eliza/pull/1968
* @rekpero made their first contribution in https://github.com/elizaOS/eliza/pull/1966
* @conache made their first contribution in https://github.com/elizaOS/eliza/pull/1955
* @mbcse made their first contribution in https://github.com/elizaOS/eliza/pull/1950
* @sekmet made their first contribution in https://github.com/elizaOS/eliza/pull/1943
* @iankm made their first contribution in https://github.com/elizaOS/eliza/pull/1418
* @Rahat-ch made their first contribution in https://github.com/elizaOS/eliza/pull/1621
* @hazelnutcloud made their first contribution in https://github.com/elizaOS/eliza/pull/1902
* @kush-alloralabs made their first contribution in https://github.com/elizaOS/eliza/pull/2003
* @rferrari made their first contribution in https://github.com/elizaOS/eliza/pull/2006
* @kamalbuilds made their first contribution in https://github.com/elizaOS/eliza/pull/1895
* @koofree made their first contribution in https://github.com/elizaOS/eliza/pull/2008
* @RonTuretzky made their first contribution in https://github.com/elizaOS/eliza/pull/1673
* @wtfsayo made their first contribution in https://github.com/elizaOS/eliza/pull/2016
* @kristjanpeterson1 made their first contribution in https://github.com/elizaOS/eliza/pull/2011
* @jonathanykh made their first contribution in https://github.com/elizaOS/eliza/pull/2015
* @dto-simba made their first contribution in https://github.com/elizaOS/eliza/pull/2014
* @mitchoz made their first contribution in https://github.com/elizaOS/eliza/pull/1868
* @WAGMIBRO made their first contribution in https://github.com/elizaOS/eliza/pull/2026
* @antman1p made their first contribution in https://github.com/elizaOS/eliza/pull/2031
* @brauliolomeli made their first contribution in https://github.com/elizaOS/eliza/pull/2030
* @AnonJon made their first contribution in https://github.com/elizaOS/eliza/pull/2044
* @taofengno1 made their first contribution in https://github.com/elizaOS/eliza/pull/2048
* @bayological made their first contribution in https://github.com/elizaOS/eliza/pull/2042
* @tripathiarpan20 made their first contribution in https://github.com/elizaOS/eliza/pull/2022
* @DanielWahl made their first contribution in https://github.com/elizaOS/eliza/pull/2062
* @ShuochengWang made their first contribution in https://github.com/elizaOS/eliza/pull/1470
* @bxngxl made their first contribution in https://github.com/elizaOS/eliza/pull/2069
* @YANGSEOKWOO made their first contribution in https://github.com/elizaOS/eliza/pull/2074
* @mameikagou made their first contribution in https://github.com/elizaOS/eliza/pull/2112
* @web3gh made their first contribution in https://github.com/elizaOS/eliza/pull/2099
* @Hugo-SEQUIER made their first contribution in https://github.com/elizaOS/eliza/pull/1708
* @maciejwitowski made their first contribution in https://github.com/elizaOS/eliza/pull/2125
* @prasadabhishek made their first contribution in https://github.com/elizaOS/eliza/pull/2091
* @autonome-ai made their first contribution in https://github.com/elizaOS/eliza/pull/2121
* @pranjallyad made their first contribution in https://github.com/elizaOS/eliza/pull/2101
* @tudorpintea999 made their first contribution in https://github.com/elizaOS/eliza/pull/2138
* @w3-bounty made their first contribution in https://github.com/elizaOS/eliza/pull/821
* @rRogick made their first contribution in https://github.com/elizaOS/eliza/pull/2088
* @Jonatan-Chaverri made their first contribution in https://github.com/elizaOS/eliza/pull/2029
* @earlyvibz made their first contribution in https://github.com/elizaOS/eliza/pull/2141
* @rellfy made their first contribution in https://github.com/elizaOS/eliza/pull/2045
* @peterjah made their first contribution in https://github.com/elizaOS/eliza/pull/1582
* @0xalank made their first contribution in https://github.com/elizaOS/eliza/pull/2083
* @xiangxiecrypto made their first contribution in https://github.com/elizaOS/eliza/pull/2086
* @ChainRex made their first contribution in https://github.com/elizaOS/eliza/pull/2150
* @nhodges made their first contribution in https://github.com/elizaOS/eliza/pull/2178
* @AAAkater made their first contribution in https://github.com/elizaOS/eliza/pull/2177
* @Riroaki made their first contribution in https://github.com/elizaOS/eliza/pull/2179
* @zoe27 made their first contribution in https://github.com/elizaOS/eliza/pull/1755
</details>

#### Full Changelog: https://github.com/elizaOS/eliza/compare/v0.1.7...v0.1.8

---

## v0.1.7 (January 04, 2025)

#### What's Changed

* chore: rebase develop branch by @shakkernerd in https://github.com/elizaOS/eliza/pull/1301
* no token needed for gaianet by @suicidalgoofy in https://github.com/elizaOS/eliza/pull/1306
* fix: add lint script for plugin evm and fix lint errors by @nicky-ru in https://github.com/elizaOS/eliza/pull/1171
* chore: remove TWITTER_COOKIES env var by @ChristopherTrimboli in https://github.com/elizaOS/eliza/pull/1288
* fix: update turbo to fix "cannot find package" error by @oxSaturn in https://github.com/elizaOS/eliza/pull/1307
* fix: set default value for cache store by @oxSaturn in https://github.com/elizaOS/eliza/pull/1308
* fix: support google model. by @oxSaturn in https://github.com/elizaOS/eliza/pull/1310
* chore: bump agent-twitter-client version to v0.0.17 by @shakkernerd in https://github.com/elizaOS/eliza/pull/1311
* fix: use MAX_TWEET_LENGTH from setting by @oxSaturn in https://github.com/elizaOS/eliza/pull/1323
* fix: Add OLLAMA model to the getTokenForProvider class by @amirkhonov in https://github.com/elizaOS/eliza/pull/1338
* fix: postgres adapter schema by @ryanleecode in https://github.com/elizaOS/eliza/pull/1345
* Update farcaster client max cast length by @0x330a in https://github.com/elizaOS/eliza/pull/1347
* chore: revert discord url by @madjin in https://github.com/elizaOS/eliza/pull/1355
* feat: elizaOS by @lalalune in https://github.com/elizaOS/eliza/pull/1352
* chore: Merge Develop into Main by @lalalune in https://github.com/elizaOS/eliza/pull/1356
* Update DOCUMENTATION links to point to https://elizaOS.github.io/eliza/ by @imwylin in https://github.com/elizaOS/eliza/pull/1353
* feat: change @elizaos/eliza to @elizaos/core by @lalalune in https://github.com/elizaOS/eliza/pull/1357
* chore: develop -> main, change elizaos/eliza to elizaos/core by @lalalune in https://github.com/elizaOS/eliza/pull/1359
* chore: New version 0.1.7 alpha.1 by @shakkernerd in https://github.com/elizaOS/eliza/pull/1360
* chore: bump version to v0.1.7-alpha.1 by @shakkernerd in https://github.com/elizaOS/eliza/pull/1361
* fix: explicitly set env in each step by @shakkernerd in https://github.com/elizaOS/eliza/pull/1374
* Update README.md to instructions to start client for chatting with Agent by @onlyzerosonce in https://github.com/elizaOS/eliza/pull/1375
* docs: Add documentation on pnpm node version by @trbutler4 in https://github.com/elizaOS/eliza/pull/1350
* chore: change CI trigger by @shakkernerd in https://github.com/elizaOS/eliza/pull/1387
* chore: require approval for integration test step by @shakkernerd in https://github.com/elizaOS/eliza/pull/1388
* chore: split tests by @shakkernerd in https://github.com/elizaOS/eliza/pull/1390
* docs: sample plugin documentation by @ileana-pr in https://github.com/elizaOS/eliza/pull/1385
* docs: Add "What Did You Get Done This Week? #6" notes by @YoungPhlo in https://github.com/elizaOS/eliza/pull/1399
* Standardize boolean values and update .env file pattern by @hcaumo in https://github.com/elizaOS/eliza/pull/1392
* fix: duplicate tweet log by @jasonqindev in https://github.com/elizaOS/eliza/pull/1402
* fix: postgres adapter settings not being applied by @ryanleecode in https://github.com/elizaOS/eliza/pull/1379
* fix: image generation using imageSettings by @proteanx in https://github.com/elizaOS/eliza/pull/1371
* feat: add venice style presets & option to remove watermark (image generation) by @proteanx in https://github.com/elizaOS/eliza/pull/1410
* chore: allow scoped pr titles by @ryanleecode in https://github.com/elizaOS/eliza/pull/1414
* chore: format package.json files with prettier by @ryanleecode in https://github.com/elizaOS/eliza/pull/1412
* fix: Twitter login notifications, incorrect cookie management.  by @ChristopherTrimboli in https://github.com/elizaOS/eliza/pull/1330
* fix: Multiple Agents running at the same time on localhost by @0xCardinalError in https://github.com/elizaOS/eliza/pull/1415
* fix:  tags in templates/examples empty when passed to LLM by @tcm390 in https://github.com/elizaOS/eliza/pull/1305
* fix: fix imageModelProvider apiKey selection fallback  by @UD1sto in https://github.com/elizaOS/eliza/pull/1272
* chore: update env for plugin-goat by @aeither in https://github.com/elizaOS/eliza/pull/1180
* docs: Add Tagalog README Translation by @harveyjavier in https://github.com/elizaOS/eliza/pull/1420
* feat: [Code Scanning] Security Improvements - create codeql.yml by @monilpat in https://github.com/elizaOS/eliza/pull/1314
* feat: greet first time contributors by @monilpat in https://github.com/elizaOS/eliza/pull/1316
* feat: add auto PR / issue close after being stale for a certain amount of time by @monilpat in https://github.com/elizaOS/eliza/pull/1317
* feat: add `only` to booleanFooter by @fyInALT in https://github.com/elizaOS/eliza/pull/1437
* improve logging in plugin-coinbase by @alessandromazza98 in https://github.com/elizaOS/eliza/pull/1429
* Update eliza-in-tee.md (fixing typo) by @yerinle in https://github.com/elizaOS/eliza/pull/1428
* fix: typos by @omahs in https://github.com/elizaOS/eliza/pull/1423
* docs: 1.Quotation marks are used incorrectly.2.Delete duplicate words by @RiceChuan in https://github.com/elizaOS/eliza/pull/1424
* feat: client-github retry by @tomguluson92 in https://github.com/elizaOS/eliza/pull/1425
* feat: (plugin-evm) add alienx chain by @xwxtwd in https://github.com/elizaOS/eliza/pull/1438
* chore: Keeps README translations synchronized by @0xJord4n in https://github.com/elizaOS/eliza/pull/1432
* feat: add abstract plugin by @cygaar in https://github.com/elizaOS/eliza/pull/1225
* fix: Make search feature in twitter client works by @nulLeeKH in https://github.com/elizaOS/eliza/pull/1433
* fix: fix incorrect link redirection issue by @mhxw in https://github.com/elizaOS/eliza/pull/1443
* fix: Remove code duplication in  getGoals call by @hanyh2004 in https://github.com/elizaOS/eliza/pull/1450
* Feat: update package.json to add Cleanstart options for new database by @harperaa in https://github.com/elizaOS/eliza/pull/1449
* feat: suppress initial message from action by @0xPBIT in https://github.com/elizaOS/eliza/pull/1444
* New default character by @lalalune in https://github.com/elizaOS/eliza/pull/1453
* feat: added docs for plugin-nft-generation by @vishal-kanna in https://github.com/elizaOS/eliza/pull/1327
* feat: Add Text to 3D function by @tomguluson92 in https://github.com/elizaOS/eliza/pull/1446
* fix: update pnpm lock by @odilitime in https://github.com/elizaOS/eliza/pull/1457
* feat: allow passing secrets through environment by @odilitime in https://github.com/elizaOS/eliza/pull/1454
* feat: Add ModelConfiguration to Character to enable adjusting temperature, response length & penalties  by @peersky in https://github.com/elizaOS/eliza/pull/1455
* feat: replace `unruggable-core` with `unruggable-sdk` by @remiroyc in https://github.com/elizaOS/eliza/pull/450
* chore: update defailt character topic test case by @shakkernerd in https://github.com/elizaOS/eliza/pull/1466
* docs: Fixed Incorrect Model Name in API Integration by @mdqst in https://github.com/elizaOS/eliza/pull/1465
* feat: Adding plugin for Cronos ZKEVM by @samarth30 in https://github.com/elizaOS/eliza/pull/1464
* fix: client-twitter: fix ENABLE_ACTION_PROCESSING logic by @zkvm in https://github.com/elizaOS/eliza/pull/1463
* fix: cronoszkEVM -> cronoszkevm by @shakkernerd in https://github.com/elizaOS/eliza/pull/1468
* fix(core) make modelConfiguration optional by @Archethect in https://github.com/elizaOS/eliza/pull/1473
* fix: cleaner interaction prompts in the Twitter plugin by @todorkolev in https://github.com/elizaOS/eliza/pull/1469
* fix: duplicate twitter post by @tcm390 in https://github.com/elizaOS/eliza/pull/1472
* chore: Docs update by @madjin in https://github.com/elizaOS/eliza/pull/1476
* Fetch timeline for followed accounts via Twitter client methods by @ag-wnl in https://github.com/elizaOS/eliza/pull/1475
* chore: Do not consider self tweets when evaluating actions by @ag-wnl in https://github.com/elizaOS/eliza/pull/1477
* fix: client-discord chat_with_attachment action remove hard coded model, allow any tiktoken model by @harperaa in https://github.com/elizaOS/eliza/pull/1408
* feat: Enhance client direct by @shakkernerd in https://github.com/elizaOS/eliza/pull/1479
* feat: improve chat formatting line breaks by @swizzmagik in https://github.com/elizaOS/eliza/pull/1483
* feat: add image features to react chat client by @0xPBIT in https://github.com/elizaOS/eliza/pull/1481
* feat: Twitter Post Action Implementation by @0xPBIT in https://github.com/elizaOS/eliza/pull/1422
* feat: Add agentic JSDoc generation   by @Ed-Marcavage in https://github.com/elizaOS/eliza/pull/1343
* feat: add readme for ton plugin by @chandiniv1 in https://github.com/elizaOS/eliza/pull/1496
* feat: add readme for websearch plugin by @chandiniv1 in https://github.com/elizaOS/eliza/pull/1494
* chore: fix typos by @qwdsds in https://github.com/elizaOS/eliza/pull/1489
* docs: Fixed a small syntax issue in the ModelClass Update fine-tuning.md by @mdqst in https://github.com/elizaOS/eliza/pull/1493
* add CODE_OF_CONDUCT.md by @nulLeeKH in https://github.com/elizaOS/eliza/pull/1487
* fix: remove `type` when import from `elizaos` by @tomguluson92 in https://github.com/elizaOS/eliza/pull/1492
* fix: improve Twitter client dry run mode and configuration logging by @e-fu in https://github.com/elizaOS/eliza/pull/1498
* feat: extend parseBooleanFromText function with additional boolean values by @shakkernerd in https://github.com/elizaOS/eliza/pull/1501
* docs: bad links in eliza-in-tee.md by @janeyJo in https://github.com/elizaOS/eliza/pull/1500
* fix: improve client type identification with test coverage by @ShaneOxM in https://github.com/elizaOS/eliza/pull/1490
* feat: handle long tweet by @tcm390 in https://github.com/elizaOS/eliza/pull/1339
* chore: general code fixes/clean up by @shakkernerd in https://github.com/elizaOS/eliza/pull/1513
* add fuel plugin by @Dhaiwat10 in https://github.com/elizaOS/eliza/pull/1512
* fix: add required incremental option and remove invalid typescript configuration by @ShaneOxM in https://github.com/elizaOS/eliza/pull/1485
* Clear `/cache/` in `clean.sh` script by @timolegros in https://github.com/elizaOS/eliza/pull/1508
* chore: Revert "Clear `/cache/` in `clean.sh` script" by @shakkernerd in https://github.com/elizaOS/eliza/pull/1515
* chore: remove cache in core by @shakkernerd in https://github.com/elizaOS/eliza/pull/1516
* feat: Add the FerePro plugin by @Rudrakc in https://github.com/elizaOS/eliza/pull/1502
* fix: Update speech.ts by @y4my4my4m in https://github.com/elizaOS/eliza/pull/1312
* fix: swap and bridge actions of plugin-evm by @pythonberg1997 in https://github.com/elizaOS/eliza/pull/1456
* fix: client-twitter lowerCase bug and environment clean up (+lint fixes, and TWITTER_SEARCH_ENABLE double start fix) by @odilitime in https://github.com/elizaOS/eliza/pull/1514
* feat: use OPENAI_API_URL from env to support custom OpenAI API endpoint by @imtms in https://github.com/elizaOS/eliza/pull/1522
* fix: handle long tweet in utils by @oxSaturn in https://github.com/elizaOS/eliza/pull/1520
* feat: add /:agentId/speak endpoint for text-to-speech functionality by @HowieDuhzit in https://github.com/elizaOS/eliza/pull/1528
* Fix: Update package.json with build-docker command to match the dockerfile command by @vanshika-srivastava in https://github.com/elizaOS/eliza/pull/1527
* feat: Add Livepeer Image Provider by @Titan-Node in https://github.com/elizaOS/eliza/pull/1525
* feat: Add Custom System Prompt Support for plugin-image-generation  by @tsubasakong in https://github.com/elizaOS/eliza/pull/839
* chore: remove unused vars by @odilitime in https://github.com/elizaOS/eliza/pull/1529
* feat: add avalanche plugin by @snow-farmer in https://github.com/elizaOS/eliza/pull/842
* feat: Add GitBook Plugin provider by @azep-ninja in https://github.com/elizaOS/eliza/pull/1126
* chore: bump version to v.0.1.7-alpha.2 by @shakkernerd in https://github.com/elizaOS/eliza/pull/1530
* chore: 1.7.0 prep, develop => main by @odilitime in https://github.com/elizaOS/eliza/pull/1519
* feat: add autoscroll chat client by @swizzmagik in https://github.com/elizaOS/eliza/pull/1538
* docs: Polish readme by @yanushevitz in https://github.com/elizaOS/eliza/pull/1537
* Update README_CN - Model Configuration by @RedHorse823 in https://github.com/elizaOS/eliza/pull/1535
* docs: fix grammar/typos in README by @SK1989sL in https://github.com/elizaOS/eliza/pull/1534
* Fix: make twitter engagement criteria in prompt more focused on relevance to topics/interests/character by @e-fu in https://github.com/elizaOS/eliza/pull/1533
* feat: improve stale pr/issue messages by @monilpat in https://github.com/elizaOS/eliza/pull/1540
* fix: twitter usernames can start with numbers by @odilitime in https://github.com/elizaOS/eliza/pull/1541
* Fix jsdoc automation build issue & parametrize PR branch target by @Ed-Marcavage in https://github.com/elizaOS/eliza/pull/1547
* fix: Telegram Bad Request: can't parse entities by @azep-ninja in https://github.com/elizaOS/eliza/pull/1546
* Chore: Refactor Imports. Improve PR Template by @mgunnin in https://github.com/elizaOS/eliza/pull/1545
* docs: Add JSDoc documentation by @madjin in https://github.com/elizaOS/eliza/pull/1549
* docs: Add JSDoc documentation by @madjin in https://github.com/elizaOS/eliza/pull/1548
* feat: add theme toggle functionality with dark and light mode support by @zkfriendly in https://github.com/elizaOS/eliza/pull/1555
* docs: Add "What Did You Get Done This Week? #7" notes by @YoungPhlo in https://github.com/elizaOS/eliza/pull/1559
* feat: (example) script to show how to add system prompt and templates to eliza with character file by @HashWarlock in https://github.com/elizaOS/eliza/pull/1554
* feat: parse files through prettier by @shakkernerd in https://github.com/elizaOS/eliza/pull/1573
* fix: init 768 dimension in database for gaianet by @L-jasmine in https://github.com/elizaOS/eliza/pull/1572
* docs: overview and preview of technical report by @tomguluson92 in https://github.com/elizaOS/eliza/pull/1574
* feat: add TEE support for plugin-env by @samuveth in https://github.com/elizaOS/eliza/pull/1571
* Update agents.md - minor update by @yorkerhodes3 in https://github.com/elizaOS/eliza/pull/1579
* refactor(plugin-conflux): output detailed invalid content by @bendanzhentan in https://github.com/elizaOS/eliza/pull/1602
* fix: tweak transfer template of plugin-evm by @zkvm in https://github.com/elizaOS/eliza/pull/1604
* feat: add experimental telemetry model option by @zhourunlai in https://github.com/elizaOS/eliza/pull/1603
* docs: README.md files for plugins  by @ileana-pr in https://github.com/elizaOS/eliza/pull/1601
* feat: use tavily sdk by @zhourunlai in https://github.com/elizaOS/eliza/pull/1599
* docs: add readme spanish version in docs by @salazarsebas in https://github.com/elizaOS/eliza/pull/1594
* feat: add docs for image generation plugin by @chandiniv1 in https://github.com/elizaOS/eliza/pull/1591
* docs: fix Contributing Guide by @0xFloyd in https://github.com/elizaOS/eliza/pull/1589
* feat: update volcengine model by @zhourunlai in https://github.com/elizaOS/eliza/pull/1586
* fix: update plugin-solana workspace dependencies by @shakkernerd in https://github.com/elizaOS/eliza/pull/1609
* fix: Google API Key not passing from character file by @azep-ninja in https://github.com/elizaOS/eliza/pull/1607
* add plugins to the key components section of the faq by @cole-gillespie in https://github.com/elizaOS/eliza/pull/1614
* add an client-direct endpoint to get memories by agentid and roomid by @treppers in https://github.com/elizaOS/eliza/pull/1581
* fix: Double Responses from Continue Action by @azep-ninja in https://github.com/elizaOS/eliza/pull/1606
* Fix double spaced tweets in Post.ts by @suicidalgoofy in https://github.com/elizaOS/eliza/pull/1626
* feat: Select a transcription provider based on the character settings. by @tcm390 in https://github.com/elizaOS/eliza/pull/1625
* fix: turbo deps for plugin-evm by @odilitime in https://github.com/elizaOS/eliza/pull/1627
* feat: Twitter Spaces Integration by @slkzgm in https://github.com/elizaOS/eliza/pull/1550
* fix: corrected path for image upload by @ShreyGanatra in https://github.com/elizaOS/eliza/pull/1632
* chore: update viem dependency version in plugin-evm and plugin-goat by @bertux in https://github.com/elizaOS/eliza/pull/1637
* fix: lockfile wasn't updated after dependency + bring viem to root level package.json by @monilpat in https://github.com/elizaOS/eliza/pull/1642
* fix: Fix bug in plugin-bootstrap/src/evaluators/facts.ts by @metakai1 in https://github.com/elizaOS/eliza/pull/1648
* Add README_AR.md by @xMariem in https://github.com/elizaOS/eliza/pull/1634
* Added Hungarian README by @mdominikd in https://github.com/elizaOS/eliza/pull/1645
* fix: activate web-search plugin in agents/ by @cmadaanaya in https://github.com/elizaOS/eliza/pull/1577
* fix: 1634  fix image description service by @nusk0 in https://github.com/elizaOS/eliza/pull/1667
* fix: Seperated imageModelProvider and imageVisionModelProvider for ImageDescriptioServices by @denizekiz in https://github.com/elizaOS/eliza/pull/1664
* fix: Update Supabase schema.sql by @0xRider in https://github.com/elizaOS/eliza/pull/1660
* feat: add docs for story plugin by @chandiniv1 in https://github.com/elizaOS/eliza/pull/1672
* fix: add web search to agent by @odilitime in https://github.com/elizaOS/eliza/pull/1676
* fix: 1668  fix twitter image link by @nusk0 in https://github.com/elizaOS/eliza/pull/1671
* chore(docs): rename ai16z/eliza to elizaOS/eliza by @9547 in https://github.com/elizaOS/eliza/pull/1679
* fix: smoke tests by @shakkernerd in https://github.com/elizaOS/eliza/pull/1695
* feat: Plugin sui support for suiprivatekey0x account by @v1xingyue in https://github.com/elizaOS/eliza/pull/1693
* docs: update README.md spelling by @SK1989sL in https://github.com/elizaOS/eliza/pull/1690
* chore: twitter username validation message by @daizhengxue in https://github.com/elizaOS/eliza/pull/1698
* Update README_KOR.md: Added missing sections and improved Korean translations for clarity by @gnujoow in https://github.com/elizaOS/eliza/pull/1683
* fix(core): trimTokens no need to await by @9547 in https://github.com/elizaOS/eliza/pull/1686
* chore: update web search plugin export by @affaan-m in https://github.com/elizaOS/eliza/pull/1688
* EVM plugin wallet provider and transfer action improvements by @nicky-ru in https://github.com/elizaOS/eliza/pull/1701
* fix: Url fix in imagedescriptionservice by @denizekiz in https://github.com/elizaOS/eliza/pull/1696
* feat: improve GOAT integration by allowing tool calling when using generateText by @0xaguspunk in https://github.com/elizaOS/eliza/pull/1403
* fix: postgres-adapter - remove nonsensical schema check by @ryanleecode in https://github.com/elizaOS/eliza/pull/1377
* fix: disable trust provider for PostGres db by @swizzmagik in https://github.com/elizaOS/eliza/pull/1536
* fix: multiple web search import in agent by @shakkernerd in https://github.com/elizaOS/eliza/pull/1718
* chore(zksync-era): rm not used imports by @9547 in https://github.com/elizaOS/eliza/pull/1716
* fix: add echochambers to agent by @odilitime in https://github.com/elizaOS/eliza/pull/1719
* docs: update faq.md by @TresFlames in https://github.com/elizaOS/eliza/pull/1746
* docs: update README_KOR.md by @osrm in https://github.com/elizaOS/eliza/pull/1739
* docs: add Serbian README translation by @marsic3 in https://github.com/elizaOS/eliza/pull/1757
* fix: Support for Non-OpenAI Models in Token Trimming by @tcm390 in https://github.com/elizaOS/eliza/pull/1605
* fix: build lint errors by @shakkernerd in https://github.com/elizaOS/eliza/pull/1759
* fix(client): improve Windows compatibility for Vite dev server by @gmh5225 in https://github.com/elizaOS/eliza/pull/1760
* feat: use custom conditions for live monorepo types by @ryanleecode in https://github.com/elizaOS/eliza/pull/1365
* feat: support for eternalai provider can write request/response log info by @genesis-0000 in https://github.com/elizaOS/eliza/pull/1740
* feat(plugin-near): replace console.log to eliza logger by @sinecose in https://github.com/elizaOS/eliza/pull/1745
* Agentic Eliza Plugin Documenter - Multilingual (e.g., English, Spanish, French) by @Ed-Marcavage in https://github.com/elizaOS/eliza/pull/1675
* 🐛 fix plugins.md formatting for docs with dockerized docs validation by @marcellodesales in https://github.com/elizaOS/eliza/pull/1722
* fix: line break handling in chat by @swizzmagik in https://github.com/elizaOS/eliza/pull/1784
* chore: remove unused import and var by @shakkernerd in https://github.com/elizaOS/eliza/pull/1797
* bug : Removed FerePro plugin by @Rudrakc in https://github.com/elizaOS/eliza/pull/1795
* fix(client-slack): implement Media type properties in message attachments #1384 by @AIFlowML in https://github.com/elizaOS/eliza/pull/1741
* fix(postgres): Handle vector extension creation properly (#1561) by @AIFlowML in https://github.com/elizaOS/eliza/pull/1743
* Revert "fix(postgres): Handle vector extension creation properly (#1561)" by @shakkernerd in https://github.com/elizaOS/eliza/pull/1799
* fix: standardize ACTION_INTERVAL unit to minutes in twitter client by @sin-bufan in https://github.com/elizaOS/eliza/pull/1738
* refactor: client api by @aalimsahin in https://github.com/elizaOS/eliza/pull/1713
* feat: Simulate discord typing while generating a response by @dxlliv in https://github.com/elizaOS/eliza/pull/1712
* fix: bugfix. the port 80 is not listening use 3000 by @jmikedupont2 in https://github.com/elizaOS/eliza/pull/1616
* chore: install with no frozen-lockfile flag by @shakkernerd in https://github.com/elizaOS/eliza/pull/1802
* fix: generation tests for trimTokens by @shakkernerd in https://github.com/elizaOS/eliza/pull/1803
* chore: bump version to v.0.1.7 by @shakkernerd in https://github.com/elizaOS/eliza/pull/1804
* chore: Develop => main for 1.7.0 release by @odilitime in https://github.com/elizaOS/eliza/pull/1717

#### New Contributors

<details>
<summary>View New Contributors</summary>
* @suicidalgoofy made their first contribution in https://github.com/elizaOS/eliza/pull/1306
* @ChristopherTrimboli made their first contribution in https://github.com/elizaOS/eliza/pull/1288
* @amirkhonov made their first contribution in https://github.com/elizaOS/eliza/pull/1338
* @ryanleecode made their first contribution in https://github.com/elizaOS/eliza/pull/1345
* @0x330a made their first contribution in https://github.com/elizaOS/eliza/pull/1347
* @imwylin made their first contribution in https://github.com/elizaOS/eliza/pull/1353
* @onlyzerosonce made their first contribution in https://github.com/elizaOS/eliza/pull/1375
* @trbutler4 made their first contribution in https://github.com/elizaOS/eliza/pull/1350
* @hcaumo made their first contribution in https://github.com/elizaOS/eliza/pull/1392
* @jasonqindev made their first contribution in https://github.com/elizaOS/eliza/pull/1402
* @UD1sto made their first contribution in https://github.com/elizaOS/eliza/pull/1272
* @aeither made their first contribution in https://github.com/elizaOS/eliza/pull/1180
* @harveyjavier made their first contribution in https://github.com/elizaOS/eliza/pull/1420
* @fyInALT made their first contribution in https://github.com/elizaOS/eliza/pull/1437
* @alessandromazza98 made their first contribution in https://github.com/elizaOS/eliza/pull/1429
* @yerinle made their first contribution in https://github.com/elizaOS/eliza/pull/1428
* @omahs made their first contribution in https://github.com/elizaOS/eliza/pull/1423
* @RiceChuan made their first contribution in https://github.com/elizaOS/eliza/pull/1424
* @0xJord4n made their first contribution in https://github.com/elizaOS/eliza/pull/1432
* @nulLeeKH made their first contribution in https://github.com/elizaOS/eliza/pull/1433
* @mhxw made their first contribution in https://github.com/elizaOS/eliza/pull/1443
* @hanyh2004 made their first contribution in https://github.com/elizaOS/eliza/pull/1450
* @harperaa made their first contribution in https://github.com/elizaOS/eliza/pull/1449
* @0xPBIT made their first contribution in https://github.com/elizaOS/eliza/pull/1444
* @vishal-kanna made their first contribution in https://github.com/elizaOS/eliza/pull/1327
* @remiroyc made their first contribution in https://github.com/elizaOS/eliza/pull/450
* @mdqst made their first contribution in https://github.com/elizaOS/eliza/pull/1465
* @samarth30 made their first contribution in https://github.com/elizaOS/eliza/pull/1464
* @zkvm made their first contribution in https://github.com/elizaOS/eliza/pull/1463
* @Archethect made their first contribution in https://github.com/elizaOS/eliza/pull/1473
* @todorkolev made their first contribution in https://github.com/elizaOS/eliza/pull/1469
* @ag-wnl made their first contribution in https://github.com/elizaOS/eliza/pull/1475
* @swizzmagik made their first contribution in https://github.com/elizaOS/eliza/pull/1483
* @Ed-Marcavage made their first contribution in https://github.com/elizaOS/eliza/pull/1343
* @chandiniv1 made their first contribution in https://github.com/elizaOS/eliza/pull/1496
* @qwdsds made their first contribution in https://github.com/elizaOS/eliza/pull/1489
* @e-fu made their first contribution in https://github.com/elizaOS/eliza/pull/1498
* @janeyJo made their first contribution in https://github.com/elizaOS/eliza/pull/1500
* @ShaneOxM made their first contribution in https://github.com/elizaOS/eliza/pull/1490
* @Dhaiwat10 made their first contribution in https://github.com/elizaOS/eliza/pull/1512
* @timolegros made their first contribution in https://github.com/elizaOS/eliza/pull/1508
* @Rudrakc made their first contribution in https://github.com/elizaOS/eliza/pull/1502
* @y4my4my4m made their first contribution in https://github.com/elizaOS/eliza/pull/1312
* @pythonberg1997 made their first contribution in https://github.com/elizaOS/eliza/pull/1456
* @imtms made their first contribution in https://github.com/elizaOS/eliza/pull/1522
* @HowieDuhzit made their first contribution in https://github.com/elizaOS/eliza/pull/1528
* @vanshika-srivastava made their first contribution in https://github.com/elizaOS/eliza/pull/1527
* @snow-farmer made their first contribution in https://github.com/elizaOS/eliza/pull/842
* @yanushevitz made their first contribution in https://github.com/elizaOS/eliza/pull/1537
* @RedHorse823 made their first contribution in https://github.com/elizaOS/eliza/pull/1535
* @SK1989sL made their first contribution in https://github.com/elizaOS/eliza/pull/1534
* @mgunnin made their first contribution in https://github.com/elizaOS/eliza/pull/1545
* @zkfriendly made their first contribution in https://github.com/elizaOS/eliza/pull/1555
* @yorkerhodes3 made their first contribution in https://github.com/elizaOS/eliza/pull/1579
* @bendanzhentan made their first contribution in https://github.com/elizaOS/eliza/pull/1602
* @zhourunlai made their first contribution in https://github.com/elizaOS/eliza/pull/1603
* @salazarsebas made their first contribution in https://github.com/elizaOS/eliza/pull/1594
* @0xFloyd made their first contribution in https://github.com/elizaOS/eliza/pull/1589
* @cole-gillespie made their first contribution in https://github.com/elizaOS/eliza/pull/1614
* @treppers made their first contribution in https://github.com/elizaOS/eliza/pull/1581
* @slkzgm made their first contribution in https://github.com/elizaOS/eliza/pull/1550
* @ShreyGanatra made their first contribution in https://github.com/elizaOS/eliza/pull/1632
* @bertux made their first contribution in https://github.com/elizaOS/eliza/pull/1637
* @metakai1 made their first contribution in https://github.com/elizaOS/eliza/pull/1648
* @xMariem made their first contribution in https://github.com/elizaOS/eliza/pull/1634
* @mdominikd made their first contribution in https://github.com/elizaOS/eliza/pull/1645
* @cmadaanaya made their first contribution in https://github.com/elizaOS/eliza/pull/1577
* @nusk0 made their first contribution in https://github.com/elizaOS/eliza/pull/1667
* @0xRider made their first contribution in https://github.com/elizaOS/eliza/pull/1660
* @daizhengxue made their first contribution in https://github.com/elizaOS/eliza/pull/1698
* @gnujoow made their first contribution in https://github.com/elizaOS/eliza/pull/1683
* @affaan-m made their first contribution in https://github.com/elizaOS/eliza/pull/1688
* @TresFlames made their first contribution in https://github.com/elizaOS/eliza/pull/1746
* @osrm made their first contribution in https://github.com/elizaOS/eliza/pull/1739
* @marsic3 made their first contribution in https://github.com/elizaOS/eliza/pull/1757
* @gmh5225 made their first contribution in https://github.com/elizaOS/eliza/pull/1760
* @sinecose made their first contribution in https://github.com/elizaOS/eliza/pull/1745
* @marcellodesales made their first contribution in https://github.com/elizaOS/eliza/pull/1722
* @aalimsahin made their first contribution in https://github.com/elizaOS/eliza/pull/1713
* @dxlliv made their first contribution in https://github.com/elizaOS/eliza/pull/1712
* @jmikedupont2 made their first contribution in https://github.com/elizaOS/eliza/pull/1616
</details>

#### Full Changelog: https://github.com/elizaOS/eliza/compare/v0.1.6...v0.1.7

---

## v0.1.6 (December 21, 2024)

#### What's Changed

* fix: When the plugins field in the .character.json file is configured with plugin name. by @xwxtwd in https://github.com/ai16z/eliza/pull/784
* fixs: uuid compatible for number by @tomguluson92 in https://github.com/ai16z/eliza/pull/785
* Update generation.ts to fix TOGETHER/LLAMACLOUD image generation by @ProphetX10 in https://github.com/ai16z/eliza/pull/786
* fix: dev command by @shakkernerd in https://github.com/ai16z/eliza/pull/793
* chore: update README_KOR.md to match latest README.md by @mike0295 in https://github.com/ai16z/eliza/pull/789
* fix: enviroment -> environment by @tomguluson92 in https://github.com/ai16z/eliza/pull/787
* fix: Docker default non-interactive mode for Cloud instances by @rarepepi in https://github.com/ai16z/eliza/pull/796
* fix: swap type error, create user trust on first message in telegram by @MarcoMandar in https://github.com/ai16z/eliza/pull/800
* fix: update npm publication workflow by @cygaar in https://github.com/ai16z/eliza/pull/805
* refactor: Improve actions samples random selection by @dievardump in https://github.com/ai16z/eliza/pull/799
* fix: part 2 of updating the npm publish workflow by @cygaar in https://github.com/ai16z/eliza/pull/806
* fix: release workflow part 3 by @cygaar in https://github.com/ai16z/eliza/pull/807
* fix: update package version to v0.1.5-alpha.0 by @cygaar in https://github.com/ai16z/eliza/pull/808
* fix: lerna publish command by @cygaar in https://github.com/ai16z/eliza/pull/811
* feat: (core) Add circuit breaker pattern for database operations -… by @augchan42 in https://github.com/ai16z/eliza/pull/812
* use github access token by @tcm390 in https://github.com/ai16z/eliza/pull/825
* loading indicator by @tcm390 in https://github.com/ai16z/eliza/pull/827
* fix: pin all node dependencies + update @solana/web3.js to safe version by @cygaar in https://github.com/ai16z/eliza/pull/832
* fix: docker-setup.md by @Freytes in https://github.com/ai16z/eliza/pull/826
* fix: twitter cache expires by @palsp in https://github.com/ai16z/eliza/pull/824
* chore: bump version to 0.1.5-alpha.1 by @cygaar in https://github.com/ai16z/eliza/pull/833
* chore: revert viem package version by @shakkernerd in https://github.com/ai16z/eliza/pull/834
* chore: Revert/viem version and bump @goat-sdk/plugin-erc20 by @shakkernerd in https://github.com/ai16z/eliza/pull/836
* chore: bump version to 0.1.5-alpha.3 by @cygaar in https://github.com/ai16z/eliza/pull/838
* feat: add coinbase  ERC20, ERC721, and ERC1155 tokenContract deployment / invokement plugin by @monilpat in https://github.com/ai16z/eliza/pull/803
* fix: Include scripts/postinstall.js in the final NPM package by @martincik in https://github.com/ai16z/eliza/pull/843
* fix: run release workflow after a github release is created by @cygaar in https://github.com/ai16z/eliza/pull/846
* feat: add Aptos plugin by @0xaptosj in https://github.com/ai16z/eliza/pull/818
* fix: plugins docs by @cygaar in https://github.com/ai16z/eliza/pull/848
* fix: Use LARGE models for responses by @lalalune in https://github.com/ai16z/eliza/pull/853
* Update Node version in local-development.md by @oxSaturn in https://github.com/ai16z/eliza/pull/850
* Updated quickstart.md to contemplate common issue by @fede2442 in https://github.com/ai16z/eliza/pull/861
* Remove duplicated coinbase CDP options in .env.example by @juntao in https://github.com/ai16z/eliza/pull/863
* feat: coinbase webhook + add more examples + testing by @monilpat in https://github.com/ai16z/eliza/pull/801
* test: adding environment and knowledge tests by @ai16z-demirix in https://github.com/ai16z/eliza/pull/862
* Update quickstart.md by @oxSaturn in https://github.com/ai16z/eliza/pull/872
* docs: Add AI Agent Dev School Parts 2 and 3 summaries and timestamps by @YoungPhlo in https://github.com/ai16z/eliza/pull/877
* Add google model env vars by @peersky in https://github.com/ai16z/eliza/pull/875
* feat: working farcaster client with neynar by @sayangel in https://github.com/ai16z/eliza/pull/570
* fix: re-enable coverage report upload to Codecov in CI workflow by @snobbee in https://github.com/ai16z/eliza/pull/880
* chore: disable building docs on build command by @shakkernerd in https://github.com/ai16z/eliza/pull/884
* feat: Add Flow Blockchain plugin  by @btspoony in https://github.com/ai16z/eliza/pull/874
* chore: enhance dev script, performance improvement and add help message by @shakkernerd in https://github.com/ai16z/eliza/pull/887
* chore: added more help message to the important notice text. by @shakkernerd in https://github.com/ai16z/eliza/pull/891
* chore: improved dev command by @shakkernerd in https://github.com/ai16z/eliza/pull/892
* fix: twitter actions not triggering by @cygaar in https://github.com/ai16z/eliza/pull/903
* chore: update models for groq by @oxSaturn in https://github.com/ai16z/eliza/pull/890
* fix: evaluation json parsing by @cygaar in https://github.com/ai16z/eliza/pull/907
* docs: Add What Did You Get Done This Week #4 summaries and timestamps by @YoungPhlo in https://github.com/ai16z/eliza/pull/895
* feat: create README_TH.md  by @asianviking in https://github.com/ai16z/eliza/pull/918
* feat: update gaianet config by @L-jasmine in https://github.com/ai16z/eliza/pull/915
* feat: allow users to configure models for groq by @oxSaturn in https://github.com/ai16z/eliza/pull/910
* chore: Consistent language for Community & Contact link label by @golryang in https://github.com/ai16z/eliza/pull/899
* chore: deprecate text based way of generating JSON by @monilpat in https://github.com/ai16z/eliza/pull/920
* fix: Farcater client cleanup and fixed response logic by @sayangel in https://github.com/ai16z/eliza/pull/914
* feat: MAX_TWEET_LENGTH env implementation by @onur-saf in https://github.com/ai16z/eliza/pull/912
* feat: implement advanced coinbase trading by @monilpat in https://github.com/ai16z/eliza/pull/725
* feat: add dynamic watch paths for agent development by @samuveth in https://github.com/ai16z/eliza/pull/931
* fix: use of Heurist model env vars by @boxhock in https://github.com/ai16z/eliza/pull/924
* fix: update quickstart and .env.example by @oxSaturn in https://github.com/ai16z/eliza/pull/932
* feat: add readContract / invokeContract functionality to Coinbase plugin by @monilpat in https://github.com/ai16z/eliza/pull/923
* fix: telegram response memory userId to agentId by @bmgalego in https://github.com/ai16z/eliza/pull/948
* feat: Config eternalai model from env by @genesis-0000 in https://github.com/ai16z/eliza/pull/927
* feat: add hyperbolic api to eliza by @meppsilon in https://github.com/ai16z/eliza/pull/828
* docs: add WSL installation guide by @ileana-pr in https://github.com/ai16z/eliza/pull/946
* fix: Revert "docs: add WSL installation guide" by @monilpat in https://github.com/ai16z/eliza/pull/959
* Fix farcaster client process action issue by @sin-bufan in https://github.com/ai16z/eliza/pull/963
* fix(agent): correct EVM plugin activation condition by @0xAsten in https://github.com/ai16z/eliza/pull/962
* fix: use MAX_TWEET_LENGTH from setting by @oxSaturn in https://github.com/ai16z/eliza/pull/960
* feat: Supports upload files to AWS S3. by @xwxtwd in https://github.com/ai16z/eliza/pull/941
* fix: update package name in faq by @oxSaturn in https://github.com/ai16z/eliza/pull/937
* feat: process all responses actions by @bmgalego in https://github.com/ai16z/eliza/pull/940
* chore: 947 add other evm chains to wallet by @n00b21337 in https://github.com/ai16z/eliza/pull/949
* feat: add dev script to plugin-aptos by @asianviking in https://github.com/ai16z/eliza/pull/956
* feat: Add hyperbolic env vars to override model class by @meppsilon in https://github.com/ai16z/eliza/pull/974
* chore: pass env variables when setting up GOAT and update GOAT readme by @0xaguspunk in https://github.com/ai16z/eliza/pull/898
* feat: Add TEE Mode to Solana Plugin by @HashWarlock in https://github.com/ai16z/eliza/pull/835
* chore: fix broken lockfile by @shakkernerd in https://github.com/ai16z/eliza/pull/977
* fix: revert llamacloud endpoint change by @odilitime in https://github.com/ai16z/eliza/pull/954
* feat: add callback handler to runtime evaluate method by @bmgalego in https://github.com/ai16z/eliza/pull/938
* fix: docker trying to filter out missing docs package by @odilitime in https://github.com/ai16z/eliza/pull/978
* chore: rename intiface plugin by @odilitime in https://github.com/ai16z/eliza/pull/955
* feat: allow character.json settings models for open router by @odilitime in https://github.com/ai16z/eliza/pull/953
* LinkedIn Client by @bkellgren in https://github.com/ai16z/eliza/pull/973
* fix: a typo in characterfile.md by @oxSaturn in https://github.com/ai16z/eliza/pull/986
* fix: Goat Plugin + AWS S3 Service error when env vars absent by @jnaulty in https://github.com/ai16z/eliza/pull/985
* docs: add WSL Setup Guide to documentation  by @ileana-pr in https://github.com/ai16z/eliza/pull/983
* chore: add how to startup chat ui by @yodamaster726 in https://github.com/ai16z/eliza/pull/976
* feat: flow update generate object by @btspoony in https://github.com/ai16z/eliza/pull/929
* feat : github image cicd by @v1xingyue in https://github.com/ai16z/eliza/pull/889
* feat: Add NanoGPT provider by @dylan1951 in https://github.com/ai16z/eliza/pull/926
* fix: Fix Twitter Search Logic and Add Galadriel Image Model by @dontAskVI in https://github.com/ai16z/eliza/pull/994
* feat: create README_DE.md by @GottliebFreudenreich in https://github.com/ai16z/eliza/pull/995
* test: adding parsing tests. changed files parsing.test.ts by @ai16z-demirix in https://github.com/ai16z/eliza/pull/996
* feat: allow users to configure models for openai and anthropic by @oxSaturn in https://github.com/ai16z/eliza/pull/999
* fix: typo initialize by @cryptofish7 in https://github.com/ai16z/eliza/pull/1000
* fix: add callback to action in farcaster client by @sin-bufan in https://github.com/ai16z/eliza/pull/1002
* chore: Bring Develop up to date with HEAD by @odilitime in https://github.com/ai16z/eliza/pull/1006
* feat: twitter client enhancements by @tharak123455 in https://github.com/ai16z/eliza/pull/913
* docs: Add templates documentation to the project by @Lukapetro in https://github.com/ai16z/eliza/pull/1013
* feat: Plugin evm multichain by @nicky-ru in https://github.com/ai16z/eliza/pull/1009
* test: Initial release of smoke/integration tests + testing framework by @jzvikart in https://github.com/ai16z/eliza/pull/993
* docs: "AI Agent Dev School Part 4" livestream notes by @YoungPhlo in https://github.com/ai16z/eliza/pull/1015
* chore: Twitter search switch by @odilitime in https://github.com/ai16z/eliza/pull/1003
* feat: improve Twitter client with action processing by @dorianjanezic in https://github.com/ai16z/eliza/pull/1007
* fix: refactor contributor page by @tcm390 in https://github.com/ai16z/eliza/pull/809
* chore: Update CI configuration to enable test coverage and add covera… by @snobbee in https://github.com/ai16z/eliza/pull/1019
* chore: Twitter fetchHomeTimeline rework by @odilitime in https://github.com/ai16z/eliza/pull/1021
* docs: Update README.md by @sergical in https://github.com/ai16z/eliza/pull/1024
* feat: Add custom fetch logic for agent by @v1xingyue in https://github.com/ai16z/eliza/pull/1010
* docs: Update README.md by @sergical in https://github.com/ai16z/eliza/pull/1025
* add echochambers by @savageops in https://github.com/ai16z/eliza/pull/997
* chore: Push Develop into Main by @odilitime in https://github.com/ai16z/eliza/pull/1028
* feat: create example folder with example plugin by @monilpat in https://github.com/ai16z/eliza/pull/1004
* feat: add venice.ai api model provider by @proteanx in https://github.com/ai16z/eliza/pull/1008
* feat: Add AI Agent Dev School Tutorial Link by @lalalune in https://github.com/ai16z/eliza/pull/1038
* feat: Add Discord Team features by @azep-ninja in https://github.com/ai16z/eliza/pull/1032
* docs: characterfile.md docs outdated with latest eliza version by @tqdpham96 in https://github.com/ai16z/eliza/pull/1042
* feat: improve voice processing and add deepgram transcription option by @tcm390 in https://github.com/ai16z/eliza/pull/1026
* fix: use pull_request_target for integration tests by @jnaulty in https://github.com/ai16z/eliza/pull/1035
* feat: client-discord stop implementation / agent improvements by @odilitime in https://github.com/ai16z/eliza/pull/1029
* fix: re-enable generateNewTweetLoop / lint fixes by @odilitime in https://github.com/ai16z/eliza/pull/1043
* chore: release develop into main by @odilitime in https://github.com/ai16z/eliza/pull/1045
* chore: improve smokeTests environment validation and logging by @aramxc in https://github.com/ai16z/eliza/pull/1046
* fix: add auto to clients in types to use client-auto by @HashWarlock in https://github.com/ai16z/eliza/pull/1050
* feat: add/change change through REST api (client-direct) by @odilitime in https://github.com/ai16z/eliza/pull/1052
* fix: discord client ci issues by @cygaar in https://github.com/ai16z/eliza/pull/1054
* fix: Fix pnpm lockfiles by @jzvikart in https://github.com/ai16z/eliza/pull/1055
* fix: Allow bot to post tweets with images generated by the imageGenerationPlugin by @tcm390 in https://github.com/ai16z/eliza/pull/1040
* feat: Add Telegram Team features  by @azep-ninja in https://github.com/ai16z/eliza/pull/1033
* feat: add venice.ai image generation by @proteanx in https://github.com/ai16z/eliza/pull/1057
* feat: improve X/Twitter login with cookie validation and retry mechanism by @arslanaybars in https://github.com/ai16z/eliza/pull/856
* feat: create README_VI.md by @tqdpham96 in https://github.com/ai16z/eliza/pull/1058
* Update docs (CONTRIBUTING.md) by @lessuselesss in https://github.com/ai16z/eliza/pull/1053
* feat: add README_TH.md in docs directory by @derRizzMeister in https://github.com/ai16z/eliza/pull/1034
* feat: multiversx plugin by @mgavrila in https://github.com/ai16z/eliza/pull/860
* feat: Add NEAR Protocol plugin by @serrrfirat in https://github.com/ai16z/eliza/pull/847
* chore: commented out unused variables in solana swap action's plugin by @shakkernerd in https://github.com/ai16z/eliza/pull/1073
* fix: incorrect eslint config file path by @shakkernerd in https://github.com/ai16z/eliza/pull/1074
* feat: add plugin-ton by @jinbangyi in https://github.com/ai16z/eliza/pull/1039
* fix: remove unnecessary devDependencies by @shakkernerd in https://github.com/ai16z/eliza/pull/1075
* chore: Update package.json by @Freytes in https://github.com/ai16z/eliza/pull/1031
* chore: improve eslint by --cache by @shengxj1 in https://github.com/ai16z/eliza/pull/1056
* fix: missing eslint config file by @shakkernerd in https://github.com/ai16z/eliza/pull/1076
* fix: remove unnecessary devDependencies by @shakkernerd in https://github.com/ai16z/eliza/pull/1077
* Add slack plugin by @AIFlowML in https://github.com/ai16z/eliza/pull/859
* fix: errors in swap action in plugin-near by @shakkernerd in https://github.com/ai16z/eliza/pull/1078
* Adding plugin for ZKsync Era by @arose00 in https://github.com/ai16z/eliza/pull/906
* fix: transfer action linting errors by @shakkernerd in https://github.com/ai16z/eliza/pull/1079
* chore: add npmignore file by @shakkernerd in https://github.com/ai16z/eliza/pull/1080
* chore: fix broken pnpm lockfile by @shakkernerd in https://github.com/ai16z/eliza/pull/1081
* fix: eslint command by @shakkernerd in https://github.com/ai16z/eliza/pull/1082
* chore: remove unnecessary packages by @shakkernerd in https://github.com/ai16z/eliza/pull/1083
* fix: dynamic import of fs module by @shakkernerd in https://github.com/ai16z/eliza/pull/1084
* chore: remove unused imports and rename runtime variable by @shakkernerd in https://github.com/ai16z/eliza/pull/1085
* fix: client slack linting errors by @shakkernerd in https://github.com/ai16z/eliza/pull/1086
* fix: syntax error: invalid arithmetic operator by @shakkernerd in https://github.com/ai16z/eliza/pull/1088
* chore: increase timeout to 3mins by @shakkernerd in https://github.com/ai16z/eliza/pull/1092
* chore: kill pnpm start by @shakkernerd in https://github.com/ai16z/eliza/pull/1093
* chore: debugging start behaviour by @shakkernerd in https://github.com/ai16z/eliza/pull/1094
* docs: add README.md to plugin-evm by @nicky-ru in https://github.com/ai16z/eliza/pull/1095
* fix: return types of createAgent & startAgent by @BlockJuic3 in https://github.com/ai16z/eliza/pull/1097
* feat: Smoke Test script by @shakkernerd in https://github.com/ai16z/eliza/pull/1101
* feat: allow users to configure models for grok by @oxSaturn in https://github.com/ai16z/eliza/pull/1091
* test: adding tests. changed files actions.test.ts, messages.test.ts, models.test.ts by @ai16z-demirix in https://github.com/ai16z/eliza/pull/998
* chore: improving client typing by @BalanaguYashwanth in https://github.com/ai16z/eliza/pull/1036
* fix: handle no termination message by @shakkernerd in https://github.com/ai16z/eliza/pull/1102
* chore: fix broken pnpm lockfile by @shakkernerd in https://github.com/ai16z/eliza/pull/1103
* fix: Fixed twitter posts include from including `/n` in the text by @Titan-Node in https://github.com/ai16z/eliza/pull/1070
* fix: add missing imports by @shakkernerd in https://github.com/ai16z/eliza/pull/1104
* chore: improve formatting of .env.example for better readability by @guzus in https://github.com/ai16z/eliza/pull/897
* feat: Lens client by @imthatcarlos in https://github.com/ai16z/eliza/pull/1098
* feat: Add plugin-nft-generation: create Solana NFT collections. by @xwxtwd in https://github.com/ai16z/eliza/pull/1011
* Documentation: Plugin list numbering and titles by @brunocalmels in https://github.com/ai16z/eliza/pull/1107
* feat: add plugin-sui by @jnaulty in https://github.com/ai16z/eliza/pull/934
* feat: plugin-story by @jacob-tucker in https://github.com/ai16z/eliza/pull/1030
* Fix/charity by @awidearray in https://github.com/ai16z/eliza/pull/852
* Feat: Update community section of docs by @madjin in https://github.com/ai16z/eliza/pull/1111
* fix: Revert "Feat: Update community section of docs" by @monilpat in https://github.com/ai16z/eliza/pull/1112
* feat: New docs for community section by @madjin in https://github.com/ai16z/eliza/pull/1114
* chore: fix broken pnpm lockfile by @shakkernerd in https://github.com/ai16z/eliza/pull/1115
* fix: load image from diff endpoints by @qgpcybs in https://github.com/ai16z/eliza/pull/837
* feat: Updated characters types, Discord & Telegram enhancements by @azep-ninja in https://github.com/ai16z/eliza/pull/957
* FAL image settings escape hatch by @daojonesceo in https://github.com/ai16z/eliza/pull/814
* fix: add more heplful default agents (Dobby and C3PO) by @n00b21337 in https://github.com/ai16z/eliza/pull/1124
* fix: discord client duplicate function removal by @azep-ninja in https://github.com/ai16z/eliza/pull/1125
* fix: Refactor to prevent unnecessary lockfile changes by @monilpat in https://github.com/ai16z/eliza/pull/1120
* fix: fix the name by @n00b21337 in https://github.com/ai16z/eliza/pull/1133
* feat: Add `chatapi.akash.network` to available list of model providers (FREE LLAMA API ACCESS!) by @MbBrainz in https://github.com/ai16z/eliza/pull/1131
* feat: add support for handlebars templating engine as an option by @erise133 in https://github.com/ai16z/eliza/pull/1136
* clean newlines for new tweet by @owlcode in https://github.com/ai16z/eliza/pull/1141
* fix: telegram client duplicate function removal by @azep-ninja in https://github.com/ai16z/eliza/pull/1140
* fix: Fix Parameter Parsing in plugin-evm TransferAction and Return Transaction Hash by @FWangZil in https://github.com/ai16z/eliza/pull/965
* feat: allow agents to create/buy/sell tokens on FOMO.fund's bonding curve in plugin-solana by @0xNerd in https://github.com/ai16z/eliza/pull/1135
* chore: remove comment by @shakkernerd in https://github.com/ai16z/eliza/pull/1143
* fix: remove docker compose command since Docker file already runs by @rarepepi in https://github.com/ai16z/eliza/pull/1139
* fix: improve fomo integration by @odilitime in https://github.com/ai16z/eliza/pull/1147
* chore: fix PR #1147 by @odilitime in https://github.com/ai16z/eliza/pull/1148
* chore: Merge monday, merging develop into main by @odilitime in https://github.com/ai16z/eliza/pull/1144
* feat: update packages version script by @shakkernerd in https://github.com/ai16z/eliza/pull/1150
* chore: bump version to 0.1.6-alpha.3 by @shakkernerd in https://github.com/ai16z/eliza/pull/1152
* fix: fetch log level to debug by @shakkernerd in https://github.com/ai16z/eliza/pull/1153
* fix: fix direct-client ability to start agents by @odilitime in https://github.com/ai16z/eliza/pull/1154
* chore: develop into main by @shakkernerd in https://github.com/ai16z/eliza/pull/1155
* fix: client twitter login and auth handler by @shakkernerd in https://github.com/ai16z/eliza/pull/1158
* chore: bump version to 0.1.6-alpha.4 by @shakkernerd in https://github.com/ai16z/eliza/pull/1159
* fix: Enable multiple bots to join Discord voice channels by @tcm390 in https://github.com/ai16z/eliza/pull/1156
* chore: print commands to start the client and remove unused --non-itera… by @yang-han in https://github.com/ai16z/eliza/pull/1163
* feat: make script dash compatible by @shakkernerd in https://github.com/ai16z/eliza/pull/1165
* fix: Fix typo in multiversx plugin prompt for creating token by @thomasWos in https://github.com/ai16z/eliza/pull/1170
* docs: Update "What Did You Get Done This Week? 5" spaces notes by @YoungPhlo in https://github.com/ai16z/eliza/pull/1174
* docs: fixed CONTRIBUTING.md file Issue: 1048 by @ileana-pr in https://github.com/ai16z/eliza/pull/1191
* test: adding tests for runtime.ts. Modified README since we switched to vitest by @ai16z-demirix in https://github.com/ai16z/eliza/pull/1190
* feat: integration tests fixes + library improvements by @jzvikart in https://github.com/ai16z/eliza/pull/1177
* docs(cn): add python 3.7 by @9547 in https://github.com/ai16z/eliza/pull/1201
* fix: gitpod cicd bug by @v1xingyue in https://github.com/ai16z/eliza/pull/1207
* docs: Update README.md by @marcNY in https://github.com/ai16z/eliza/pull/1209
* docs: Update "CN README" with more details by @tomguluson92 in https://github.com/ai16z/eliza/pull/1196
* chore: New docs by @madjin in https://github.com/ai16z/eliza/pull/1211
* fix: improve twitter post generation prompt by @cygaar in https://github.com/ai16z/eliza/pull/1217
* fix: Allow the bot to post messages with images generated by the imageGenerationPlugin on Telegram. by @tcm390 in https://github.com/ai16z/eliza/pull/1220
* fix: postgres needs the user to exist before you can add a participant by @odilitime in https://github.com/ai16z/eliza/pull/1219
* fix: CircuitBreaker.ts by @tomguluson92 in https://github.com/ai16z/eliza/pull/1226
* chore: clean up scripts by @danbednarski in https://github.com/ai16z/eliza/pull/1218
* fix: fail when cannot get token, add Akash to generateText switch by @vpavlin in https://github.com/ai16z/eliza/pull/1214
* feat: add parse mode=Markdown, enhance telegram bot output by @simpletrontdip in https://github.com/ai16z/eliza/pull/1229
* feat: make twitter login retry times as env by @renlulu in https://github.com/ai16z/eliza/pull/1244
* fix: Sync UI Client with server port env by @jonathangus in https://github.com/ai16z/eliza/pull/1239
* Update README for french, spanish and italian language by @azurwastaken in https://github.com/ai16z/eliza/pull/1236
* Update trump.character.json - Enhance terminology in the project for clarity and inclusivity by @yjshi2015 in https://github.com/ai16z/eliza/pull/1237
* Fix visibility issue github image cicd by @luisalrp in https://github.com/ai16z/eliza/pull/1243
* fix: twitterShouldRespondTemplate Fails When Defined as a String in JSON Character Config by @tcm390 in https://github.com/ai16z/eliza/pull/1242
* fix: optional chaining on search to avoid startup errors when search is not enabled by @netdragonx in https://github.com/ai16z/eliza/pull/1202
* feat: make express payload limit configurable by @renlulu in https://github.com/ai16z/eliza/pull/1245
* fix: Fix local_llama key warning by @odilitime in https://github.com/ai16z/eliza/pull/1250
* doc: add Twitter automation label notice (#1253) by @julienbrs in https://github.com/ai16z/eliza/pull/1254
* Update trump.character.json by @lalalune in https://github.com/ai16z/eliza/pull/1252
* fix: unsupported model provider: claude_vertex by @tcm390 in https://github.com/ai16z/eliza/pull/1258
* feat: upgrade Tavily API with comprehensive input and constrain the token consumption by @tomguluson92 in https://github.com/ai16z/eliza/pull/1246
* feat: add README_DE.md in docs directory by @derRizzMeister in https://github.com/ai16z/eliza/pull/1262
* fix: pnpm lockfile by @shakkernerd in https://github.com/ai16z/eliza/pull/1273
* chore: Revert "fix: pnpm lockfile" by @shakkernerd in https://github.com/ai16z/eliza/pull/1275
* fix: Fix client.push issue and update README for Slack client verification by @SumeetChougule in https://github.com/ai16z/eliza/pull/1182
* fix: write summary file before trying to cache it by @tobbelobb in https://github.com/ai16z/eliza/pull/1205
* fix: fix ENABLE_ACTION_PROCESSING logic by @oxSaturn in https://github.com/ai16z/eliza/pull/1268
* fix: fix lockfile by @odilitime in https://github.com/ai16z/eliza/pull/1283
* chore: clean up merged PR1168 by @odilitime in https://github.com/ai16z/eliza/pull/1289
* feat: Redis Cache Implementation by @shakkernerd in https://github.com/ai16z/eliza/pull/1279
* fix: integration tests fix by @twilwa in https://github.com/ai16z/eliza/pull/1291
* fix: pnpm lock file by @shakkernerd in https://github.com/ai16z/eliza/pull/1292
* fix: add missing claude vertex case to handleProvider by @shakkernerd in https://github.com/ai16z/eliza/pull/1293
* fix: output checkable variable for conditional by @twilwa in https://github.com/ai16z/eliza/pull/1294
* feat: Add caching support for Redis by @shakkernerd in https://github.com/ai16z/eliza/pull/1295
* chore: bump version to 0.1.6-alpha.5 by @shakkernerd in https://github.com/ai16z/eliza/pull/1296
* feat: Update main for v0.1.6-alpha.5 by @odilitime in https://github.com/ai16z/eliza/pull/1290
* fix: remove clients from default character by @shakkernerd in https://github.com/ai16z/eliza/pull/1297
* fix: default character model to LLAMALOCAL by @shakkernerd in https://github.com/ai16z/eliza/pull/1299
* feat: release version 0.1.6 by @shakkernerd in https://github.com/ai16z/eliza/pull/1300

#### New Contributors

<details>
<summary>View New Contributors</summary>
* @xwxtwd made their first contribution in https://github.com/ai16z/eliza/pull/784
* @ProphetX10 made their first contribution in https://github.com/ai16z/eliza/pull/786
* @mike0295 made their first contribution in https://github.com/ai16z/eliza/pull/789
* @rarepepi made their first contribution in https://github.com/ai16z/eliza/pull/796
* @dievardump made their first contribution in https://github.com/ai16z/eliza/pull/799
* @palsp made their first contribution in https://github.com/ai16z/eliza/pull/824
* @0xaptosj made their first contribution in https://github.com/ai16z/eliza/pull/818
* @oxSaturn made their first contribution in https://github.com/ai16z/eliza/pull/850
* @fede2442 made their first contribution in https://github.com/ai16z/eliza/pull/861
* @juntao made their first contribution in https://github.com/ai16z/eliza/pull/863
* @peersky made their first contribution in https://github.com/ai16z/eliza/pull/875
* @sayangel made their first contribution in https://github.com/ai16z/eliza/pull/570
* @asianviking made their first contribution in https://github.com/ai16z/eliza/pull/918
* @golryang made their first contribution in https://github.com/ai16z/eliza/pull/899
* @onur-saf made their first contribution in https://github.com/ai16z/eliza/pull/912
* @samuveth made their first contribution in https://github.com/ai16z/eliza/pull/931
* @boxhock made their first contribution in https://github.com/ai16z/eliza/pull/924
* @meppsilon made their first contribution in https://github.com/ai16z/eliza/pull/828
* @ileana-pr made their first contribution in https://github.com/ai16z/eliza/pull/946
* @sin-bufan made their first contribution in https://github.com/ai16z/eliza/pull/963
* @0xAsten made their first contribution in https://github.com/ai16z/eliza/pull/962
* @n00b21337 made their first contribution in https://github.com/ai16z/eliza/pull/949
* @bkellgren made their first contribution in https://github.com/ai16z/eliza/pull/973
* @jnaulty made their first contribution in https://github.com/ai16z/eliza/pull/985
* @dylan1951 made their first contribution in https://github.com/ai16z/eliza/pull/926
* @GottliebFreudenreich made their first contribution in https://github.com/ai16z/eliza/pull/995
* @cryptofish7 made their first contribution in https://github.com/ai16z/eliza/pull/1000
* @tharak123455 made their first contribution in https://github.com/ai16z/eliza/pull/913
* @Lukapetro made their first contribution in https://github.com/ai16z/eliza/pull/1013
* @nicky-ru made their first contribution in https://github.com/ai16z/eliza/pull/1009
* @jzvikart made their first contribution in https://github.com/ai16z/eliza/pull/993
* @sergical made their first contribution in https://github.com/ai16z/eliza/pull/1024
* @savageops made their first contribution in https://github.com/ai16z/eliza/pull/997
* @proteanx made their first contribution in https://github.com/ai16z/eliza/pull/1008
* @azep-ninja made their first contribution in https://github.com/ai16z/eliza/pull/1032
* @tqdpham96 made their first contribution in https://github.com/ai16z/eliza/pull/1042
* @aramxc made their first contribution in https://github.com/ai16z/eliza/pull/1046
* @arslanaybars made their first contribution in https://github.com/ai16z/eliza/pull/856
* @derRizzMeister made their first contribution in https://github.com/ai16z/eliza/pull/1034
* @mgavrila made their first contribution in https://github.com/ai16z/eliza/pull/860
* @serrrfirat made their first contribution in https://github.com/ai16z/eliza/pull/847
* @jinbangyi made their first contribution in https://github.com/ai16z/eliza/pull/1039
* @shengxj1 made their first contribution in https://github.com/ai16z/eliza/pull/1056
* @AIFlowML made their first contribution in https://github.com/ai16z/eliza/pull/859
* @arose00 made their first contribution in https://github.com/ai16z/eliza/pull/906
* @BlockJuic3 made their first contribution in https://github.com/ai16z/eliza/pull/1097
* @BalanaguYashwanth made their first contribution in https://github.com/ai16z/eliza/pull/1036
* @Titan-Node made their first contribution in https://github.com/ai16z/eliza/pull/1070
* @guzus made their first contribution in https://github.com/ai16z/eliza/pull/897
* @imthatcarlos made their first contribution in https://github.com/ai16z/eliza/pull/1098
* @brunocalmels made their first contribution in https://github.com/ai16z/eliza/pull/1107
* @jacob-tucker made their first contribution in https://github.com/ai16z/eliza/pull/1030
* @qgpcybs made their first contribution in https://github.com/ai16z/eliza/pull/837
* @daojonesceo made their first contribution in https://github.com/ai16z/eliza/pull/814
* @MbBrainz made their first contribution in https://github.com/ai16z/eliza/pull/1131
* @erise133 made their first contribution in https://github.com/ai16z/eliza/pull/1136
* @owlcode made their first contribution in https://github.com/ai16z/eliza/pull/1141
* @FWangZil made their first contribution in https://github.com/ai16z/eliza/pull/965
* @0xNerd made their first contribution in https://github.com/ai16z/eliza/pull/1135
* @yang-han made their first contribution in https://github.com/ai16z/eliza/pull/1163
* @thomasWos made their first contribution in https://github.com/ai16z/eliza/pull/1170
* @9547 made their first contribution in https://github.com/ai16z/eliza/pull/1201
* @marcNY made their first contribution in https://github.com/ai16z/eliza/pull/1209
* @danbednarski made their first contribution in https://github.com/ai16z/eliza/pull/1218
* @vpavlin made their first contribution in https://github.com/ai16z/eliza/pull/1214
* @simpletrontdip made their first contribution in https://github.com/ai16z/eliza/pull/1229
* @renlulu made their first contribution in https://github.com/ai16z/eliza/pull/1244
* @jonathangus made their first contribution in https://github.com/ai16z/eliza/pull/1239
* @azurwastaken made their first contribution in https://github.com/ai16z/eliza/pull/1236
* @yjshi2015 made their first contribution in https://github.com/ai16z/eliza/pull/1237
* @luisalrp made their first contribution in https://github.com/ai16z/eliza/pull/1243
* @netdragonx made their first contribution in https://github.com/ai16z/eliza/pull/1202
* @julienbrs made their first contribution in https://github.com/ai16z/eliza/pull/1254
* @SumeetChougule made their first contribution in https://github.com/ai16z/eliza/pull/1182
* @tobbelobb made their first contribution in https://github.com/ai16z/eliza/pull/1205
</details>

#### Full Changelog: https://github.com/ai16z/eliza/compare/v0.1.5...v0.1.6

---

## v0.1.5 (December 02, 2024)

#### What's Changed

* feat: adding back the renovate file for automated security scanning by @sirkitree in https://github.com/ai16z/eliza/pull/358
* feat: readme and linting by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/449
* fix: postgres embedding issues by @tarrencev in https://github.com/ai16z/eliza/pull/425
* fix: X dry run by @laser-riot in https://github.com/ai16z/eliza/pull/452
* Add npm install instructions to homepage header by @null-hax in https://github.com/ai16z/eliza/pull/459
* docs: Fix my name in stream notes by @odilitime in https://github.com/ai16z/eliza/pull/442
* feat: create-eliza-app by @coffeeorgreentea in https://github.com/ai16z/eliza/pull/462
* fix: Add missing fuzzystrmatch extension for levenshtein() method to postgresql schema.sql definition by @martincik in https://github.com/ai16z/eliza/pull/460
* fix: Fixing failling tests token.test.ts and videoGeneration.test.ts by @ai16z-demirix in https://github.com/ai16z/eliza/pull/465
* feat: init github client by @tarrencev in https://github.com/ai16z/eliza/pull/456
* docs: Add Discord username question by @odilitime in https://github.com/ai16z/eliza/pull/468
* docs: Update Contributors to bring inline with PR468 by @odilitime in https://github.com/ai16z/eliza/pull/470
* feat: Cache Manager by @bmgalego in https://github.com/ai16z/eliza/pull/378
* ollama generate case was using console.debug.  by @drew-royster in https://github.com/ai16z/eliza/pull/474
* fix: ci by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/475
* feat: Twitter Refactor by @bmgalego in https://github.com/ai16z/eliza/pull/478
* refactor: add template types by @vivoidos in https://github.com/ai16z/eliza/pull/479
* feat: adds check by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/466
* fix: ignored modelEndpointOverride in generation by @darwintree in https://github.com/ai16z/eliza/pull/446
* feat: Improvements by @bmgalego in https://github.com/ai16z/eliza/pull/482
* fix: agent type error and sqlite file env by @bmgalego in https://github.com/ai16z/eliza/pull/484
* fix: agent loadCharacters file resolver by @bmgalego in https://github.com/ai16z/eliza/pull/486
* fix: fix character path loading by @bmgalego in https://github.com/ai16z/eliza/pull/487
* fix: added missing packages to tsup configs' externals by @massivefermion in https://github.com/ai16z/eliza/pull/488
* docs: Create best-practices.md documentation by @snobbee in https://github.com/ai16z/eliza/pull/463
* feat: Added TWITTER_COOKIE example on quickstart.md by @haeunchin in https://github.com/ai16z/eliza/pull/476
* feat: Improve knowledge embeddings by @tarrencev in https://github.com/ai16z/eliza/pull/472
* feat: improve type safety by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/494
* fix: improve embeddings by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/496
* node-v by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/501
* fix: deps by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/503
* chore: add contributor license by @awidearray in https://github.com/ai16z/eliza/pull/502
* fix: remove sol dep by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/504
* fix: issue with npm by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/505
* fix: services fix by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/509
* fix: speech service fix by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/512
* docs: add template and client configuration guide by @oguzserdar in https://github.com/ai16z/eliza/pull/510
* Wrap `fastembed` in try catch to allow non node environments to build by @antpb in https://github.com/ai16z/eliza/pull/508
* fix: husky and pre-commit by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/514
* fix: lint by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/515
* test: add linter to all packages and enable vitest by @snobbee in https://github.com/ai16z/eliza/pull/490
* feat: add coinbase plugin starting with cb commerce functionality by @monilpat in https://github.com/ai16z/eliza/pull/513
* fix: Gracefully Handle Add Participants Unique Constraint Error in Postgres by @VarKrishin in https://github.com/ai16z/eliza/pull/495
* fix: Ollama fix by @yodamaster726 in https://github.com/ai16z/eliza/pull/524
* fix: ollama local and llama local by @yodamaster726 in https://github.com/ai16z/eliza/pull/521
* fix: Fix/telegram by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/530
* fix(deps): update dependency @ai-sdk/anthropic to ^0.0.56 by @renovate in https://github.com/ai16z/eliza/pull/528
* fix(deps): pin dependencies by @renovate in https://github.com/ai16z/eliza/pull/529
* chore(deps): pin dependencies by @renovate in https://github.com/ai16z/eliza/pull/526
* fix(deps): update dependency @ai-sdk/openai to v1.0.4 by @renovate in https://github.com/ai16z/eliza/pull/533
* fix(deps): update dependency @ai-sdk/google-vertex to ^0.0.43 by @renovate in https://github.com/ai16z/eliza/pull/532
* fix: pass runtime to video service by @0xFlicker in https://github.com/ai16z/eliza/pull/535
* fix: discord voice memory id not unique by @bmgalego in https://github.com/ai16z/eliza/pull/540
* fix: db queries not using agentId in all memory queries by @bmgalego in https://github.com/ai16z/eliza/pull/539
* fix: error in getGoals and remove coinbase package-lock.json  by @bmgalego in https://github.com/ai16z/eliza/pull/545
* fix: Use BigInt for tweet IDs in client-twitter by @wraitii in https://github.com/ai16z/eliza/pull/552
* fix: add try catch to process action by @bmgalego in https://github.com/ai16z/eliza/pull/546
* fix: generateText format consistency by @tomguluson92 in https://github.com/ai16z/eliza/pull/550
* fix: bump echogarden to fix case sensitive issue by @0xFlicker in https://github.com/ai16z/eliza/pull/561
* Improved Twitter Documentation by @grallc in https://github.com/ai16z/eliza/pull/559
* fix: sql command by @0xFlicker in https://github.com/ai16z/eliza/pull/560
* fix: remove db adapters dependencies from core and remove plugin-node from telegram  by @bmgalego in https://github.com/ai16z/eliza/pull/571
* fix: add missing documents and knowledge memory managers to runtime interface by @bmgalego in https://github.com/ai16z/eliza/pull/572
* fix: remove postinstall script from plugin-coinbase by @bmgalego in https://github.com/ai16z/eliza/pull/573
* fix: postgres by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/557
* fix: Token provider getHighestLiquidityPair by @bmgalego in https://github.com/ai16z/eliza/pull/547
* Add community stream notes for WDYGDTW 2 by @YoungPhlo in https://github.com/ai16z/eliza/pull/580
* feat: add new pages by @madjin in https://github.com/ai16z/eliza/pull/581
* fix: Devex Fixes by @lalalune in https://github.com/ai16z/eliza/pull/583
* feat: update api docs by @madjin in https://github.com/ai16z/eliza/pull/582
* feat: Update packages by @lalalune in https://github.com/ai16z/eliza/pull/584
* Update dependency @echogarden/espeak-ng-emscripten to v0.3.3 by @renovate in https://github.com/ai16z/eliza/pull/537
* Update dependency @opendocsg/pdf2md to v0.1.32 by @renovate in https://github.com/ai16z/eliza/pull/538
* Update dependency agent-twitter-client to v0.0.14 by @renovate in https://github.com/ai16z/eliza/pull/542
* Update docusaurus monorepo to v3.6.3 by @renovate in https://github.com/ai16z/eliza/pull/543
* Update dependency clsx to v2.1.1 by @renovate in https://github.com/ai16z/eliza/pull/544
* feat: More package updates by @lalalune in https://github.com/ai16z/eliza/pull/585
* Pin dependency vue to 3.5.13 by @renovate in https://github.com/ai16z/eliza/pull/527
* feat: Shaw/realityspiral/coinbase fixes by @lalalune in https://github.com/ai16z/eliza/pull/586
* feat: implement coinbase mass payments across base/sol/eth/pol/arb by @monilpat in https://github.com/ai16z/eliza/pull/569
* Shaw/logger fixes by @lalalune in https://github.com/ai16z/eliza/pull/587
* fix: missing updates for logger.ts by @yodamaster726 in https://github.com/ai16z/eliza/pull/525
* fix: React Client fixes by @lalalune in https://github.com/ai16z/eliza/pull/588
* feat: add agent selection, router and sidebar layout in React client by @vivoidos in https://github.com/ai16z/eliza/pull/536
* fix: fixing failing goals, cache and token tests by @ai16z-demirix in https://github.com/ai16z/eliza/pull/522
* fix: Shaw/fix zerog by @lalalune in https://github.com/ai16z/eliza/pull/589
* feat: Add 0G plugin for file storage by @Wilbert957 in https://github.com/ai16z/eliza/pull/416
* fix: enable test run in CI for core package by @pgoos in https://github.com/ai16z/eliza/pull/590
* CS - first api hookups. by @justabot in https://github.com/ai16z/eliza/pull/564
* feat: update sidebars by @madjin in https://github.com/ai16z/eliza/pull/593
* Download updates by @justabot in https://github.com/ai16z/eliza/pull/594
* feat: Farcaster Client by @bmgalego in https://github.com/ai16z/eliza/pull/386
* Pr 33 by @MarcoMandar in https://github.com/ai16z/eliza/pull/596
* fix: discord crash on sending message to null channel by @odilitime in https://github.com/ai16z/eliza/pull/598
* fix: db queries in sqljs database adapter not using agentId by @bmgalego in https://github.com/ai16z/eliza/pull/606
* fix: agent DirectClient is not a type by @odilitime in https://github.com/ai16z/eliza/pull/605
* fix: add Memory Manager getMemoriesByRoomIds missing tableName param by @bmgalego in https://github.com/ai16z/eliza/pull/602
* fix: time prompt to include UTC, convert to verbose english to help prompting by @odilitime in https://github.com/ai16z/eliza/pull/603
* feat: add knowledge to state by @bmgalego in https://github.com/ai16z/eliza/pull/600
* feat: Adding tests for actions and generation. Skipping test step in defaultCharacters by @ai16z-demirix in https://github.com/ai16z/eliza/pull/591
* feat: sell simulation service by @MarcoMandar in https://github.com/ai16z/eliza/pull/597
* fix: use correct getCachedEmbeddings query_field_sub_name by @bmgalego in https://github.com/ai16z/eliza/pull/607
* fix: knowledge module exporting process by @bmgalego in https://github.com/ai16z/eliza/pull/609
* fix: add client farcaster templates to character type by @bmgalego in https://github.com/ai16z/eliza/pull/610
* feat: make node-plugin lazy-loaded for faster boot times by @bmgalego in https://github.com/ai16z/eliza/pull/599
* chore(nvmrc): update Node.js version from v23.1.0 to v23.3.0 by @wolfcito in https://github.com/ai16z/eliza/pull/611
* fix: Fix buttplug.io integration and merge by @lalalune in https://github.com/ai16z/eliza/pull/612
* feat: Add buttplug.io integration by @8times4 in https://github.com/ai16z/eliza/pull/517
* fix: Update and add Conflux by @lalalune in https://github.com/ai16z/eliza/pull/613
* feat: add Conflux plugin by @darwintree in https://github.com/ai16z/eliza/pull/481
* feat: Add decentralized inferencing for Eliza (LLAMA, Hermes, Flux) by @genesis-0000 in https://github.com/ai16z/eliza/pull/516
* fix: memory similarity log & new knowledge ingestion by @yoniebans in https://github.com/ai16z/eliza/pull/616
* feat: starknet portfolio provider by @milancermak in https://github.com/ai16z/eliza/pull/595
* bugfix: Modify docker run error after agent folder move by @THtianhao in https://github.com/ai16z/eliza/pull/458
* fix: handle when tweet_results is empty better by @odilitime in https://github.com/ai16z/eliza/pull/620
* fix: small improvements to agent process exits by @cygaar in https://github.com/ai16z/eliza/pull/625
* Feat/sell simulation by @MarcoMandar in https://github.com/ai16z/eliza/pull/627
* fix: Add Tweet Response Deduplication Check by @tsubasakong in https://github.com/ai16z/eliza/pull/622
* fix: node package builds by @cygaar in https://github.com/ai16z/eliza/pull/636
* dicord bot voice by @tcm390 in https://github.com/ai16z/eliza/pull/633
* feat: Initial TEE Plugin by @HashWarlock in https://github.com/ai16z/eliza/pull/632
* Notes for AI Agent Dev School #1 by @YoungPhlo in https://github.com/ai16z/eliza/pull/638
* feat: Merge EVM and add character override by @lalalune in https://github.com/ai16z/eliza/pull/643
* fix: Add docs, update providers for TEE Plugin by @HashWarlock in https://github.com/ai16z/eliza/pull/640
* fix:  running a character.json fails when running per docs by @yodamaster726 in https://github.com/ai16z/eliza/pull/624
* feat: support starkname by @irisdv in https://github.com/ai16z/eliza/pull/628
* refactor: better db connection handling by @cygaar in https://github.com/ai16z/eliza/pull/635
* add connection instruction for connecting with X by @zjasper666 in https://github.com/ai16z/eliza/pull/641
* Feat/simulation sell types by @MarcoMandar in https://github.com/ai16z/eliza/pull/642
* updates postgres setup instructions in docs by @DataRelic in https://github.com/ai16z/eliza/pull/645
* Update ci.yaml by @snobbee in https://github.com/ai16z/eliza/pull/652
* feat: improve browser service by @cygaar in https://github.com/ai16z/eliza/pull/653
* added support for LlamaLocal's path outside plugin-node/dist by @dr-fusion in https://github.com/ai16z/eliza/pull/649
* CS - adding better errors and readme. by @justabot in https://github.com/ai16z/eliza/pull/654
* feat: implement coinbase trading by @monilpat in https://github.com/ai16z/eliza/pull/608
* fix: pnpm-lock.yaml by @monilpat in https://github.com/ai16z/eliza/pull/664
* feat: add minimal config file for code cov by @pgoos in https://github.com/ai16z/eliza/pull/659
* fix: embedding search for non-openai models by @cygaar in https://github.com/ai16z/eliza/pull/660
* feat: evm pubkey derivation by @St4rgarden in https://github.com/ai16z/eliza/pull/667
* fix: add missing commands to quickstart by @0xaguspunk in https://github.com/ai16z/eliza/pull/665
* Add Galadriel LLM Inference Provider by @dontAskVI in https://github.com/ai16z/eliza/pull/651
* redpill custom models by @v1xingyue in https://github.com/ai16z/eliza/pull/668
* feat: Add wallet history (transactions, balances) to coinbase providers by @monilpat in https://github.com/ai16z/eliza/pull/658
* fix: discord permissions and duplicate reactions, new /joinchannel command by @augchan42 in https://github.com/ai16z/eliza/pull/662
* feat: add image text model provider separation and fal.ai integration by @yoniebans in https://github.com/ai16z/eliza/pull/650
* feat : whatsapp by @awidearray in https://github.com/ai16z/eliza/pull/626
* feat: add ICP token creation support by @asDNSk in https://github.com/ai16z/eliza/pull/357
* integrate tavily by @tcm390 in https://github.com/ai16z/eliza/pull/518
* incorrect package install location Update plugins.md by @cryptoradagast in https://github.com/ai16z/eliza/pull/669
* fix: eslint not working by @cygaar in https://github.com/ai16z/eliza/pull/672
* fix: add missing viem dependency by @HashWarlock in https://github.com/ai16z/eliza/pull/674
* fix: embeddings for messages with urls by @cygaar in https://github.com/ai16z/eliza/pull/671
* Fix: run tests with coverage by @pgoos in https://github.com/ai16z/eliza/pull/676
* feat: improve embeddings, models and connectivity by @augchan42 in https://github.com/ai16z/eliza/pull/677
* fix: Make TEE Plugin available to launch agent & fix previous launch error by @HashWarlock in https://github.com/ai16z/eliza/pull/678
* fix: getEmbeddingZeroVector calls by @cygaar in https://github.com/ai16z/eliza/pull/682
* feat: add Turborepo by @lalalune in https://github.com/ai16z/eliza/pull/670
* feat: make twitter client polling configurable by @cygaar in https://github.com/ai16z/eliza/pull/683
* chore: remove unused packages introduced in #677 by @shakkernerd in https://github.com/ai16z/eliza/pull/693
* Fix/logging issues by @augchan42 in https://github.com/ai16z/eliza/pull/688
* chore: Remove web-agent folder - duplicate of client folder by @shakkernerd in https://github.com/ai16z/eliza/pull/699
* fix: update docker image to support turbo and reduce build time by @HashWarlock in https://github.com/ai16z/eliza/pull/702
* fix: Switch from tiktoken to js-tiktoken for worker compatibility by @antpb in https://github.com/ai16z/eliza/pull/703
* fix: simplify linting dependencies by @cygaar in https://github.com/ai16z/eliza/pull/721
* fix: twitter recent interactions by @cygaar in https://github.com/ai16z/eliza/pull/729
* feat: add new pages, update sidebar by @madjin in https://github.com/ai16z/eliza/pull/728
* feat: increase knowledge context by @cygaar in https://github.com/ai16z/eliza/pull/730
* refactor: ClientBase to use a map for managing multiple Twitter clients by account identifier by @tcm390 in https://github.com/ai16z/eliza/pull/722
* fix: move `fastembed` import to the isnode condition check by @antpb in https://github.com/ai16z/eliza/pull/709
* chore: remove unused env var by @2pmflow in https://github.com/ai16z/eliza/pull/737
* fix (core): message completion footer format by @CodingTux in https://github.com/ai16z/eliza/pull/742
* fix(deps): pin dependencies by @renovate in https://github.com/ai16z/eliza/pull/744
* fix: packagejson updated to latest agent-client 0.0.16 by @denizekiz in https://github.com/ai16z/eliza/pull/753
* Add running with Gitpod by @v1xingyue in https://github.com/ai16z/eliza/pull/758
* fix(deps): update dependency @ai-sdk/openai to v1.0.5 by @renovate in https://github.com/ai16z/eliza/pull/751
* Update environment, add twitter quality of life updates by @lalalune in https://github.com/ai16z/eliza/pull/765
* fix: improve twitter post content quality by @cygaar in https://github.com/ai16z/eliza/pull/763
* fix(deps): update dependency tailwind-merge to v2.5.5 by @renovate in https://github.com/ai16z/eliza/pull/761
* fix: recentPosts always empty by @tcm390 in https://github.com/ai16z/eliza/pull/756
* feat: Pin dependencies and unify tsconfig by @lalalune in https://github.com/ai16z/eliza/pull/767
* Update dependency dompurify to v3.2.2 by @renovate in https://github.com/ai16z/eliza/pull/548
* Update dependency @supabase/supabase-js to v2.46.2 by @renovate in https://github.com/ai16z/eliza/pull/754
* Update dependency clsx to v2.1.1 by @renovate in https://github.com/ai16z/eliza/pull/760
* Update dependency uuid to v11.0.3 by @renovate in https://github.com/ai16z/eliza/pull/766
* fix: follow-up improvements for ICP token creation (PR #357) by @asDNSk in https://github.com/ai16z/eliza/pull/757
* feat: more dependency updates by @lalalune in https://github.com/ai16z/eliza/pull/771
* fix(deps): replace dependency eslint-plugin-vitest with @vitest/eslint-plugin 1.0.1 by @renovate in https://github.com/ai16z/eliza/pull/749
* chore(deps): update dependency @eslint/js to v9.16.0 by @renovate in https://github.com/ai16z/eliza/pull/769
* chore(deps): update dependency @vitest/eslint-plugin to v1.1.13 by @renovate in https://github.com/ai16z/eliza/pull/770
* fix(deps): update sqlite related by @renovate in https://github.com/ai16z/eliza/pull/768
* fix: Integrate jin's docs changes and rebuild docs with a16z by @lalalune in https://github.com/ai16z/eliza/pull/772
* feat: Create community section by @madjin in https://github.com/ai16z/eliza/pull/745
* Integrate goat plugin by @lalalune in https://github.com/ai16z/eliza/pull/773
* feat: add goat plugin by @0xaguspunk in https://github.com/ai16z/eliza/pull/736
* Add decentralized GenAI backend  by @L-jasmine in https://github.com/ai16z/eliza/pull/762
* Integrate more LLMs, fix case issue in switch by @lalalune in https://github.com/ai16z/eliza/pull/774
* Merge more model providers and fix issues by @lalalune in https://github.com/ai16z/eliza/pull/775
* feat: Add two more providers: Ali Bailian(Qwen) and Volengine(Doubao, Bytedance) by @btspoony in https://github.com/ai16z/eliza/pull/747
* add simulator tutor for plugin-tee docs by @shelvenzhou in https://github.com/ai16z/eliza/pull/746
* feat: (voice) enhance character card voice configuration support by @augchan42 in https://github.com/ai16z/eliza/pull/698
* feat: donate 1% of coinbase transactions by default by @monilpat in https://github.com/ai16z/eliza/pull/759
* Create docker-setup.md by @Freytes in https://github.com/ai16z/eliza/pull/776
* fix: Refactor image interface and update to move llama cloud -> together provider by @lalalune in https://github.com/ai16z/eliza/pull/777
* fix: Text2Image interface refactored by @tomguluson92 in https://github.com/ai16z/eliza/pull/752
* refactor: refactor dockerfile to reduce image and build time by @HashWarlock in https://github.com/ai16z/eliza/pull/782
* feat: Update default character by @lalalune in https://github.com/ai16z/eliza/pull/781

#### New Contributors

<details>
<summary>View New Contributors</summary>
* @laser-riot made their first contribution in https://github.com/ai16z/eliza/pull/452
* @null-hax made their first contribution in https://github.com/ai16z/eliza/pull/459
* @coffeeorgreentea made their first contribution in https://github.com/ai16z/eliza/pull/462
* @drew-royster made their first contribution in https://github.com/ai16z/eliza/pull/474
* @darwintree made their first contribution in https://github.com/ai16z/eliza/pull/446
* @massivefermion made their first contribution in https://github.com/ai16z/eliza/pull/488
* @snobbee made their first contribution in https://github.com/ai16z/eliza/pull/463
* @haeunchin made their first contribution in https://github.com/ai16z/eliza/pull/476
* @awidearray made their first contribution in https://github.com/ai16z/eliza/pull/502
* @antpb made their first contribution in https://github.com/ai16z/eliza/pull/508
* @VarKrishin made their first contribution in https://github.com/ai16z/eliza/pull/495
* @yodamaster726 made their first contribution in https://github.com/ai16z/eliza/pull/524
* @0xFlicker made their first contribution in https://github.com/ai16z/eliza/pull/535
* @wraitii made their first contribution in https://github.com/ai16z/eliza/pull/552
* @tomguluson92 made their first contribution in https://github.com/ai16z/eliza/pull/550
* @grallc made their first contribution in https://github.com/ai16z/eliza/pull/559
* @YoungPhlo made their first contribution in https://github.com/ai16z/eliza/pull/580
* @Wilbert957 made their first contribution in https://github.com/ai16z/eliza/pull/416
* @pgoos made their first contribution in https://github.com/ai16z/eliza/pull/590
* @justabot made their first contribution in https://github.com/ai16z/eliza/pull/564
* @wolfcito made their first contribution in https://github.com/ai16z/eliza/pull/611
* @8times4 made their first contribution in https://github.com/ai16z/eliza/pull/517
* @genesis-0000 made their first contribution in https://github.com/ai16z/eliza/pull/516
* @yoniebans made their first contribution in https://github.com/ai16z/eliza/pull/616
* @milancermak made their first contribution in https://github.com/ai16z/eliza/pull/595
* @THtianhao made their first contribution in https://github.com/ai16z/eliza/pull/458
* @cygaar made their first contribution in https://github.com/ai16z/eliza/pull/625
* @irisdv made their first contribution in https://github.com/ai16z/eliza/pull/628
* @zjasper666 made their first contribution in https://github.com/ai16z/eliza/pull/641
* @DataRelic made their first contribution in https://github.com/ai16z/eliza/pull/645
* @dr-fusion made their first contribution in https://github.com/ai16z/eliza/pull/649
* @St4rgarden made their first contribution in https://github.com/ai16z/eliza/pull/667
* @0xaguspunk made their first contribution in https://github.com/ai16z/eliza/pull/665
* @dontAskVI made their first contribution in https://github.com/ai16z/eliza/pull/651
* @augchan42 made their first contribution in https://github.com/ai16z/eliza/pull/662
* @asDNSk made their first contribution in https://github.com/ai16z/eliza/pull/357
* @cryptoradagast made their first contribution in https://github.com/ai16z/eliza/pull/669
* @2pmflow made their first contribution in https://github.com/ai16z/eliza/pull/737
* @CodingTux made their first contribution in https://github.com/ai16z/eliza/pull/742
* @L-jasmine made their first contribution in https://github.com/ai16z/eliza/pull/762
* @btspoony made their first contribution in https://github.com/ai16z/eliza/pull/747
* @shelvenzhou made their first contribution in https://github.com/ai16z/eliza/pull/746
* @Freytes made their first contribution in https://github.com/ai16z/eliza/pull/776
</details>

#### Full Changelog: https://github.com/ai16z/eliza/compare/v0.1.3...v0.1.5

---

## v0.1.4-alpha.3 (November 28, 2024)

#### What's Changed

* feat: adding back the renovate file for automated security scanning by @sirkitree in https://github.com/ai16z/eliza/pull/358
* feat: readme and linting by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/449
* fix: postgres embedding issues by @tarrencev in https://github.com/ai16z/eliza/pull/425
* fix: X dry run by @laser-riot in https://github.com/ai16z/eliza/pull/452
* Add npm install instructions to homepage header by @null-hax in https://github.com/ai16z/eliza/pull/459
* docs: Fix my name in stream notes by @odilitime in https://github.com/ai16z/eliza/pull/442
* feat: create-eliza-app by @coffeeorgreentea in https://github.com/ai16z/eliza/pull/462
* fix: Add missing fuzzystrmatch extension for levenshtein() method to postgresql schema.sql definition by @martincik in https://github.com/ai16z/eliza/pull/460
* fix: Fixing failling tests token.test.ts and videoGeneration.test.ts by @ai16z-demirix in https://github.com/ai16z/eliza/pull/465
* feat: init github client by @tarrencev in https://github.com/ai16z/eliza/pull/456
* docs: Add Discord username question by @odilitime in https://github.com/ai16z/eliza/pull/468
* docs: Update Contributors to bring inline with PR468 by @odilitime in https://github.com/ai16z/eliza/pull/470
* feat: Cache Manager by @bmgalego in https://github.com/ai16z/eliza/pull/378
* ollama generate case was using console.debug.  by @drew-royster in https://github.com/ai16z/eliza/pull/474
* fix: ci by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/475
* feat: Twitter Refactor by @bmgalego in https://github.com/ai16z/eliza/pull/478
* refactor: add template types by @vivoidos in https://github.com/ai16z/eliza/pull/479
* feat: adds check by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/466
* fix: ignored modelEndpointOverride in generation by @darwintree in https://github.com/ai16z/eliza/pull/446
* feat: Improvements by @bmgalego in https://github.com/ai16z/eliza/pull/482
* fix: agent type error and sqlite file env by @bmgalego in https://github.com/ai16z/eliza/pull/484
* fix: agent loadCharacters file resolver by @bmgalego in https://github.com/ai16z/eliza/pull/486
* fix: fix character path loading by @bmgalego in https://github.com/ai16z/eliza/pull/487
* fix: added missing packages to tsup configs' externals by @massivefermion in https://github.com/ai16z/eliza/pull/488
* docs: Create best-practices.md documentation by @snobbee in https://github.com/ai16z/eliza/pull/463
* feat: Added TWITTER_COOKIE example on quickstart.md by @haeunchin in https://github.com/ai16z/eliza/pull/476
* feat: Improve knowledge embeddings by @tarrencev in https://github.com/ai16z/eliza/pull/472
* feat: improve type safety by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/494
* fix: improve embeddings by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/496
* node-v by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/501
* fix: deps by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/503
* chore: add contributor license by @awidearray in https://github.com/ai16z/eliza/pull/502
* fix: remove sol dep by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/504
* fix: issue with npm by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/505
* fix: services fix by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/509
* fix: speech service fix by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/512

#### New Contributors

<details>
<summary><strong>New Contributors</strong></summary>
* @laser-riot made their first contribution in https://github.com/ai16z/eliza/pull/452
* @null-hax made their first contribution in https://github.com/ai16z/eliza/pull/459
* @coffeeorgreentea made their first contribution in https://github.com/ai16z/eliza/pull/462
* @drew-royster made their first contribution in https://github.com/ai16z/eliza/pull/474
* @massivefermion made their first contribution in https://github.com/ai16z/eliza/pull/488
* @haeunchin made their first contribution in https://github.com/ai16z/eliza/pull/476
* @awidearray made their first contribution in https://github.com/ai16z/eliza/pull/502
</details>

#### Full Changelog: https://github.com/ai16z/eliza/compare/v0.1.3...v0.1.4-alpha.3

---

## v0.1.3-alpha.2 (November 20, 2024)

#### What's Changed
* fix: configs by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/431
* docs: Update contributing.md to incorporate Contribution Guidelines by @monilpat in https://github.com/ai16z/eliza/pull/430
* fix: linting and imports ready for npm by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/433
* feat: don't require .env to exist by @odilitime in https://github.com/ai16z/eliza/pull/427
* chore: Update pr.yaml to show actual condition so easier to follow by @monilpat in https://github.com/ai16z/eliza/pull/429
* fix: imports by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/435

#### Full Changelog: https://github.com/ai16z/eliza/compare/v0.1.1...v0.1.3-alpha.2

---

## v0.1.3 (November 20, 2024)

#### What's Changed

* docs: Update contributing.md to incorporate Contribution Guidelines by @monilpat in https://github.com/ai16z/eliza/pull/430
* fix: linting and imports ready for npm by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/433
* feat: don't require .env to exist by @odilitime in https://github.com/ai16z/eliza/pull/427
* chore: Update pr.yaml to show actual condition so easier to follow by @monilpat in https://github.com/ai16z/eliza/pull/429
* fix: imports by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/435
* fix: path by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/436
* fix: since agent is moved out of packages, adjust default path by @odilitime in https://github.com/ai16z/eliza/pull/432
* fix: Fix linter issues by @martincik in https://github.com/ai16z/eliza/pull/397
* feat:  add all the style guidelines to the context by @o-on-x in https://github.com/ai16z/eliza/pull/441
* fix: fixes some console logs by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/440
* fix: The bot is by default deafened and we don't want that by @martincik in https://github.com/ai16z/eliza/pull/437
* fix: unrug by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/444
* fix: voice perms by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/447

**Full Changelog**: https://github.com/ai16z/eliza/compare/v0.1.2...v0.1.3

---

## v0.1.1  (November 20, 2024)

#### What's Changed

* Groq api integration by @juke in https://github.com/ai16z/eliza/pull/194
* Updated documentation by @atvonsc in https://github.com/ai16z/eliza/pull/195
* Major documentation updates by @madjin in https://github.com/ai16z/eliza/pull/199
* swap Dao action initital by @MarcoMandar in https://github.com/ai16z/eliza/pull/196
* Swap functionality by @lalalune in https://github.com/ai16z/eliza/pull/197
* Add RedPill API Support by @HashWarlock in https://github.com/ai16z/eliza/pull/198
* Fix Discord Voice and DMs by @lalalune in https://github.com/ai16z/eliza/pull/203
* Shaw fix characters paths, .ts requirement and missings args by @lalalune in https://github.com/ai16z/eliza/pull/204
* Implement grok beta by @MeDott29 in https://github.com/ai16z/eliza/pull/216
* add the template overrides by @lalalune in https://github.com/ai16z/eliza/pull/207
* lazy load llama by @lalalune in https://github.com/ai16z/eliza/pull/220
* Abstracts Eliza into a Package to enble publishing onto NPM along with plugin system by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/214
* Add OLLAMA as Model Provider  by @o-on-x in https://github.com/ai16z/eliza/pull/221
* models.gguf stored in models file, & tsconfig changes for ref @eliza/core & other things by @o-on-x in https://github.com/ai16z/eliza/pull/224
* plugin-image-generation tsconfig.json fix & ollama error handling by @o-on-x in https://github.com/ai16z/eliza/pull/228
* Update Docs by @madjin in https://github.com/ai16z/eliza/pull/231
* update docs by @madjin in https://github.com/ai16z/eliza/pull/233
* move code out to plugins, adapters and clients by @lalalune in https://github.com/ai16z/eliza/pull/225
* Added OpenRouter model provider by @o-on-x in https://github.com/ai16z/eliza/pull/245
* Support google models in generation by @parzival418 in https://github.com/ai16z/eliza/pull/246
* trust integration by @MarcoMandar in https://github.com/ai16z/eliza/pull/248
* Working PostGres Adapter by @cvartanian in https://github.com/ai16z/eliza/pull/247
* use openai embeddings setting by @o-on-x in https://github.com/ai16z/eliza/pull/252
* refactor embeddings  by @o-on-x in https://github.com/ai16z/eliza/pull/254
* embedding set to use openai endpoint when using openai embeddings by @o-on-x in https://github.com/ai16z/eliza/pull/255
* bigint support in logger by @o-on-x in https://github.com/ai16z/eliza/pull/256
* Fix: changed claude-3-5-haiku to claude-3-5-haiku-20241022 for fixing… by @denizekiz in https://github.com/ai16z/eliza/pull/257
* Update docs by @madjin in https://github.com/ai16z/eliza/pull/253
* cachedEmbeddings fix by @dorianjanezic in https://github.com/ai16z/eliza/pull/262
* add verbose config with logger by @v1xingyue in https://github.com/ai16z/eliza/pull/249
* recommendations, token info, client auto by @MarcoMandar in https://github.com/ai16z/eliza/pull/250
* fix: docs features darkmode color by @fabianhug in https://github.com/ai16z/eliza/pull/266
* docs homepage rework by @mrpspring in https://github.com/ai16z/eliza/pull/280
* Improve Docs by @madjin in https://github.com/ai16z/eliza/pull/273
* Don't blow up if the wallet is missing by @ferric-sol in https://github.com/ai16z/eliza/pull/281
* Fix embedding calculation for sqlite by @ferric-sol in https://github.com/ai16z/eliza/pull/261
* Fix: compute unit increasein swapts, default is too low to make trans… by @denizekiz in https://github.com/ai16z/eliza/pull/276
* add modelProvider to json to resolve embeddings error by @twilwa in https://github.com/ai16z/eliza/pull/274
* fix docs: add python as a prerequisite (needed for node-gyp) by @metadiver in https://github.com/ai16z/eliza/pull/277
* Bundles by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/285
* Loaf stuff by @lalalune in https://github.com/ai16z/eliza/pull/286
* Added missing GROK model provider key initialization by @FabriceIRANKUNDA in https://github.com/ai16z/eliza/pull/296
* Added Transfer / Send Token Action by @o-on-x in https://github.com/ai16z/eliza/pull/297
* telegram: start agent after client initialization by @o-on-x in https://github.com/ai16z/eliza/pull/304
* Telegram client refactor for bot info availability by @ropresearch in https://github.com/ai16z/eliza/pull/308
* Increased llama and llama based model temperatures by @alanneary17 in https://github.com/ai16z/eliza/pull/310
* docs: add a new Japanese README by @eltociear in https://github.com/ai16z/eliza/pull/307
* Add Korean and French README by @BugByClaude in https://github.com/ai16z/eliza/pull/312
* fix service call patterns but needs testing by @lalalune in https://github.com/ai16z/eliza/pull/311
* add node version check by @thearyanag in https://github.com/ai16z/eliza/pull/299
* added working pumpfun.ts by @o-on-x in https://github.com/ai16z/eliza/pull/313
* Fix broken docs by @madjin in https://github.com/ai16z/eliza/pull/321
* docs: add a new Portuguese README version by @gabrielsants in https://github.com/ai16z/eliza/pull/320
* Update Quickstart Guide by @odilitime in https://github.com/ai16z/eliza/pull/325
* Save Trade on creation to the backend by @MarcoMandar in https://github.com/ai16z/eliza/pull/328
* utils.ts example tweet splitting by @o-on-x in https://github.com/ai16z/eliza/pull/323
* [LLM Object Generation][1/2] Leverage AI Lib's Generate Object instead of parsing strings by @monilpat in https://github.com/ai16z/eliza/pull/309
* claude vertex configs added to generation.ts (was missing) by @denizekiz in https://github.com/ai16z/eliza/pull/330
* README_KOR.md Korean version edited by a Korean  by @sumin13245 in https://github.com/ai16z/eliza/pull/329
* Dockerized application for local development, testing and deployment by @pindaroso in https://github.com/ai16z/eliza/pull/293
* fix: Build error for packages requiring @ai16z/eliza by @shakkernerd in https://github.com/ai16z/eliza/pull/331
* Docs: README.md improvements: clarify testing, add additional docker information by @odilitime in https://github.com/ai16z/eliza/pull/333
* Docs: additional Quickstart clarification and improvements by @odilitime in https://github.com/ai16z/eliza/pull/334
* added clientConfig to optionally ignore bots and DMs by @vivoidos in https://github.com/ai16z/eliza/pull/336
* feat: Add Heurist API Integration as New Model Provider by @tsubasakong in https://github.com/ai16z/eliza/pull/335
* feat: Starknet plugin by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/287
* fix: dev build by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/343
* Update Heurist Integration Documentation and Examples by @tsubasakong in https://github.com/ai16z/eliza/pull/339
* getOrCreateRecommenderWithTelegramId by @MarcoMandar in https://github.com/ai16z/eliza/pull/345
* fix: imports and cleanups by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/344
* trust fixes by @MarcoMandar in https://github.com/ai16z/eliza/pull/347
* feat: trust db by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/349
* Add Community & contact and Star History by @thejoven in https://github.com/ai16z/eliza/pull/353
* fix: solana by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/354
* fix: some trust fixes by @lalalune in https://github.com/ai16z/eliza/pull/346
* change default configuration of Heurist by @wjw12 in https://github.com/ai16z/eliza/pull/348
* update tweet interval to 90-180 mins by @oguzserdar in https://github.com/ai16z/eliza/pull/360
* feat: update docs with new stream notes by @madjin in https://github.com/ai16z/eliza/pull/364
* post time set in env by @o-on-x in https://github.com/ai16z/eliza/pull/368
* default set to new standard  post time 90-180 type: post time by @o-on-x in https://github.com/ai16z/eliza/pull/369
* feat: readme by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/370
* twitter-profile-remake by @alextitonis in https://github.com/ai16z/eliza/pull/263
* fix: bug in getRecentMessageInteractions not awating for promisses before formating by @bmgalego in https://github.com/ai16z/eliza/pull/366
* feat: starknet token transfer by @enitrat in https://github.com/ai16z/eliza/pull/373
* feat: Adding unit tests for start - Covering goals, defaultCharacters, relationships, evaulators, posts, database, messages by @ai16z-demirix in https://github.com/ai16z/eliza/pull/367
* feat: Enhance Heurist Image Generation Settings and Image Handling by @tsubasakong in https://github.com/ai16z/eliza/pull/375
* feat: install clients from plugin by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/371
* fix: openrouter 70b don't support 128000, changed to 405b in model.ts by @denizekiz in https://github.com/ai16z/eliza/pull/356
* feat: client by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/382
* feat: Complete Starknet DB Trust by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/355
* fix: client null by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/390
* fix: ca for btc was spam/fake by @thearyanag in https://github.com/ai16z/eliza/pull/374
* feat: Logging improvements by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/393
* Fix tweet truncation issue by truncating at complete sentences by @boyaloxer in https://github.com/ai16z/eliza/pull/388
* feat: Create README_ES.md by @metadiver in https://github.com/ai16z/eliza/pull/400
* Register memory managers if passed to runtime by @martincik in https://github.com/ai16z/eliza/pull/396
* fix: tsup build error (client-twitter) by @leomercier in https://github.com/ai16z/eliza/pull/402
* docs: add Russian(RU) translation of README  by @whonion in https://github.com/ai16z/eliza/pull/380
* docs: Update README_FR.md by @xclicx in https://github.com/ai16z/eliza/pull/377
* docs: add Turkish (TR) translation of README by @oguzserdar in https://github.com/ai16z/eliza/pull/376
* feat: Contextual Twitter Threads + Spam Reduction by @ropresearch in https://github.com/ai16z/eliza/pull/383
* fix: Lint by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/404
* fix: adds Groq to getTokenForProvider by @bmgalego in https://github.com/ai16z/eliza/pull/381
* fix: console by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/405
* feat: unruggable by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/398
* fix: Fixes by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/407
* docs: refresh eliza's tagline, fix broken links, unify formatting for core concepts by @wahndo in https://github.com/ai16z/eliza/pull/389
* docs: add GROK_API_KEY by @whalelephant in https://github.com/ai16z/eliza/pull/409
* Add italian README.md translation by @fabrizioff in https://github.com/ai16z/eliza/pull/411
* feat: video generation plugin by @dorianjanezic in https://github.com/ai16z/eliza/pull/394
* Readme update WSL  2 link added. by @denizekiz in https://github.com/ai16z/eliza/pull/419
* feat: services by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/412
* fix: removed ollama embeddings. fastembeddings or openai only by @o-on-x in https://github.com/ai16z/eliza/pull/413
* fix: Update adapters.md psql schema by @tarrencev in https://github.com/ai16z/eliza/pull/424
* feat: [Issue-185] Token Provider Tests  by @normand1 in https://github.com/ai16z/eliza/pull/365
* feat: unruggable on starknet by @RedBeardEth in https://github.com/ai16z/eliza/pull/418
* fix: don't continue to load if a specified file is not found by @odilitime in https://github.com/ai16z/eliza/pull/426
* feat: lerna an npm by @ponderingdemocritus in https://github.com/ai16z/eliza/pull/428

#### New Contributors

<details>
<summary>View New Contributors</summary>
* @juke made their first contribution in https://github.com/ai16z/eliza/pull/194
* @atvonsc made their first contribution in https://github.com/ai16z/eliza/pull/195
* @HashWarlock made their first contribution in https://github.com/ai16z/eliza/pull/198
* @MeDott29 made their first contribution in https://github.com/ai16z/eliza/pull/216
* @parzival418 made their first contribution in https://github.com/ai16z/eliza/pull/246
* @cvartanian made their first contribution in https://github.com/ai16z/eliza/pull/247
* @denizekiz made their first contribution in https://github.com/ai16z/eliza/pull/257
* @dorianjanezic made their first contribution in https://github.com/ai16z/eliza/pull/262
* @v1xingyue made their first contribution in https://github.com/ai16z/eliza/pull/249
* @fabianhug made their first contribution in https://github.com/ai16z/eliza/pull/266
* @mrpspring made their first contribution in https://github.com/ai16z/eliza/pull/280
* @FabriceIRANKUNDA made their first contribution in https://github.com/ai16z/eliza/pull/296
* @ropresearch made their first contribution in https://github.com/ai16z/eliza/pull/308
* @alanneary17 made their first contribution in https://github.com/ai16z/eliza/pull/310
* @BugByClaude made their first contribution in https://github.com/ai16z/eliza/pull/312
* @thearyanag made their first contribution in https://github.com/ai16z/eliza/pull/299
* @gabrielsants made their first contribution in https://github.com/ai16z/eliza/pull/320
* @odilitime made their first contribution in https://github.com/ai16z/eliza/pull/325
* @monilpat made their first contribution in https://github.com/ai16z/eliza/pull/309
* @sumin13245 made their first contribution in https://github.com/ai16z/eliza/pull/329
* @pindaroso made their first contribution in https://github.com/ai16z/eliza/pull/293
* @shakkernerd made their first contribution in https://github.com/ai16z/eliza/pull/331
* @vivoidos made their first contribution in https://github.com/ai16z/eliza/pull/336
* @tsubasakong made their first contribution in https://github.com/ai16z/eliza/pull/335
* @thejoven made their first contribution in https://github.com/ai16z/eliza/pull/353
* @wjw12 made their first contribution in https://github.com/ai16z/eliza/pull/348
* @oguzserdar made their first contribution in https://github.com/ai16z/eliza/pull/360
* @bmgalego made their first contribution in https://github.com/ai16z/eliza/pull/366
* @enitrat made their first contribution in https://github.com/ai16z/eliza/pull/373
* @ai16z-demirix made their first contribution in https://github.com/ai16z/eliza/pull/367
* @boyaloxer made their first contribution in https://github.com/ai16z/eliza/pull/388
* @martincik made their first contribution in https://github.com/ai16z/eliza/pull/396
* @whonion made their first contribution in https://github.com/ai16z/eliza/pull/380
* @xclicx made their first contribution in https://github.com/ai16z/eliza/pull/377
* @whalelephant made their first contribution in https://github.com/ai16z/eliza/pull/409
* @fabrizioff made their first contribution in https://github.com/ai16z/eliza/pull/411
* @tarrencev made their first contribution in https://github.com/ai16z/eliza/pull/424
* @normand1 made their first contribution in https://github.com/ai16z/eliza/pull/365
* @RedBeardEth made their first contribution in https://github.com/ai16z/eliza/pull/418
</details>

#### Full Changelog: https://github.com/ai16z/eliza/compare/v0.0.10...v0.1.1

---

