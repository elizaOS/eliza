[@elizaos/core v0.1.7](../index.md) / Character

# Type Alias: Character

> **Character**: `object`

Configuration for an agent character

## Type declaration

### id?

> `optional` **id**: [`UUID`](UUID.md)

Optional unique identifier

### name

> **name**: `string`

Character name

### username?

> `optional` **username**: `string`

Optional username

### system?

> `optional` **system**: `string`

Optional system prompt

### modelProvider

> **modelProvider**: [`ModelProviderName`](../enumerations/ModelProviderName.md)

Model provider to use

### imageModelProvider?

> `optional` **imageModelProvider**: [`ModelProviderName`](../enumerations/ModelProviderName.md)

Image model provider to use, if different from modelProvider

### imageVisionModelProvider?

> `optional` **imageVisionModelProvider**: [`ModelProviderName`](../enumerations/ModelProviderName.md)

Image Vision model provider to use, if different from modelProvider

### modelEndpointOverride?

> `optional` **modelEndpointOverride**: `string`

Optional model endpoint override

### templates?

> `optional` **templates**: `object`

Optional prompt templates

### templates.goalsTemplate?

> `optional` **goalsTemplate**: `string`

### templates.factsTemplate?

> `optional` **factsTemplate**: `string`

### templates.messageHandlerTemplate?

> `optional` **messageHandlerTemplate**: `string`

### templates.shouldRespondTemplate?

> `optional` **shouldRespondTemplate**: `string`

### templates.continueMessageHandlerTemplate?

> `optional` **continueMessageHandlerTemplate**: `string`

### templates.evaluationTemplate?

> `optional` **evaluationTemplate**: `string`

### templates.twitterSearchTemplate?

> `optional` **twitterSearchTemplate**: `string`

### templates.twitterActionTemplate?

> `optional` **twitterActionTemplate**: `string`

### templates.twitterPostTemplate?

> `optional` **twitterPostTemplate**: `string`

### templates.twitterMessageHandlerTemplate?

> `optional` **twitterMessageHandlerTemplate**: `string`

### templates.twitterShouldRespondTemplate?

> `optional` **twitterShouldRespondTemplate**: `string`

### templates.farcasterPostTemplate?

> `optional` **farcasterPostTemplate**: `string`

### templates.lensPostTemplate?

> `optional` **lensPostTemplate**: `string`

### templates.farcasterMessageHandlerTemplate?

> `optional` **farcasterMessageHandlerTemplate**: `string`

### templates.lensMessageHandlerTemplate?

> `optional` **lensMessageHandlerTemplate**: `string`

### templates.farcasterShouldRespondTemplate?

> `optional` **farcasterShouldRespondTemplate**: `string`

### templates.lensShouldRespondTemplate?

> `optional` **lensShouldRespondTemplate**: `string`

### templates.telegramMessageHandlerTemplate?

> `optional` **telegramMessageHandlerTemplate**: `string`

### templates.telegramShouldRespondTemplate?

> `optional` **telegramShouldRespondTemplate**: `string`

### templates.discordVoiceHandlerTemplate?

> `optional` **discordVoiceHandlerTemplate**: `string`

### templates.discordShouldRespondTemplate?

> `optional` **discordShouldRespondTemplate**: `string`

### templates.discordMessageHandlerTemplate?

> `optional` **discordMessageHandlerTemplate**: `string`

### templates.slackMessageHandlerTemplate?

> `optional` **slackMessageHandlerTemplate**: `string`

### templates.slackShouldRespondTemplate?

> `optional` **slackShouldRespondTemplate**: `string`

### bio

> **bio**: `string` \| `string`[]

Character biography

### lore

> **lore**: `string`[]

Character background lore

### messageExamples

> **messageExamples**: [`MessageExample`](../interfaces/MessageExample.md)[][]

Example messages

### postExamples

> **postExamples**: `string`[]

Example posts

### topics

> **topics**: `string`[]

Known topics

### adjectives

> **adjectives**: `string`[]

Character traits

### knowledge?

> `optional` **knowledge**: `string`[]

Optional knowledge base

### clients

> **clients**: [`Clients`](../enumerations/Clients.md)[]

Supported client platforms

### plugins

> **plugins**: [`Plugin`](Plugin.md)[]

Available plugins

### settings?

> `optional` **settings**: `object`

Optional configuration

### settings.secrets?

> `optional` **secrets**: `object`

#### Index Signature

\[`key`: `string`\]: `string`

### settings.intiface?

> `optional` **intiface**: `boolean`

### settings.imageSettings?

> `optional` **imageSettings**: `object`

### settings.imageSettings.steps?

> `optional` **steps**: `number`

### settings.imageSettings.width?

> `optional` **width**: `number`

### settings.imageSettings.height?

> `optional` **height**: `number`

### settings.imageSettings.negativePrompt?

> `optional` **negativePrompt**: `string`

### settings.imageSettings.numIterations?

> `optional` **numIterations**: `number`

### settings.imageSettings.guidanceScale?

> `optional` **guidanceScale**: `number`

### settings.imageSettings.seed?

> `optional` **seed**: `number`

### settings.imageSettings.modelId?

> `optional` **modelId**: `string`

### settings.imageSettings.jobId?

> `optional` **jobId**: `string`

### settings.imageSettings.count?

> `optional` **count**: `number`

### settings.imageSettings.stylePreset?

> `optional` **stylePreset**: `string`

### settings.imageSettings.hideWatermark?

> `optional` **hideWatermark**: `boolean`

### settings.voice?

> `optional` **voice**: `object`

### settings.voice.model?

> `optional` **model**: `string`

### settings.voice.url?

> `optional` **url**: `string`

### settings.voice.elevenlabs?

> `optional` **elevenlabs**: `object`

### settings.voice.elevenlabs.voiceId

> **voiceId**: `string`

New structured ElevenLabs config

### settings.voice.elevenlabs.model?

> `optional` **model**: `string`

### settings.voice.elevenlabs.stability?

> `optional` **stability**: `string`

### settings.voice.elevenlabs.similarityBoost?

> `optional` **similarityBoost**: `string`

### settings.voice.elevenlabs.style?

> `optional` **style**: `string`

### settings.voice.elevenlabs.useSpeakerBoost?

> `optional` **useSpeakerBoost**: `string`

### settings.model?

> `optional` **model**: `string`

### settings.modelConfig?

> `optional` **modelConfig**: [`ModelConfiguration`](../interfaces/ModelConfiguration.md)

### settings.embeddingModel?

> `optional` **embeddingModel**: `string`

### settings.chains?

> `optional` **chains**: `object`

#### Index Signature

\[`key`: `string`\]: `any`[]

### settings.chains.evm?

> `optional` **evm**: `any`[]

### settings.chains.solana?

> `optional` **solana**: `any`[]

### settings.transcription?

> `optional` **transcription**: [`TranscriptionProvider`](../enumerations/TranscriptionProvider.md)

### clientConfig?

> `optional` **clientConfig**: `object`

Optional client-specific config

### clientConfig.discord?

> `optional` **discord**: `object`

### clientConfig.discord.shouldIgnoreBotMessages?

> `optional` **shouldIgnoreBotMessages**: `boolean`

### clientConfig.discord.shouldIgnoreDirectMessages?

> `optional` **shouldIgnoreDirectMessages**: `boolean`

### clientConfig.discord.shouldRespondOnlyToMentions?

> `optional` **shouldRespondOnlyToMentions**: `boolean`

### clientConfig.discord.messageSimilarityThreshold?

> `optional` **messageSimilarityThreshold**: `number`

### clientConfig.discord.isPartOfTeam?

> `optional` **isPartOfTeam**: `boolean`

### clientConfig.discord.teamAgentIds?

> `optional` **teamAgentIds**: `string`[]

### clientConfig.discord.teamLeaderId?

> `optional` **teamLeaderId**: `string`

### clientConfig.discord.teamMemberInterestKeywords?

> `optional` **teamMemberInterestKeywords**: `string`[]

### clientConfig.discord.allowedChannelIds?

> `optional` **allowedChannelIds**: `string`[]

### clientConfig.telegram?

> `optional` **telegram**: `object`

### clientConfig.telegram.shouldIgnoreBotMessages?

> `optional` **shouldIgnoreBotMessages**: `boolean`

### clientConfig.telegram.shouldIgnoreDirectMessages?

> `optional` **shouldIgnoreDirectMessages**: `boolean`

### clientConfig.telegram.shouldRespondOnlyToMentions?

> `optional` **shouldRespondOnlyToMentions**: `boolean`

### clientConfig.telegram.shouldOnlyJoinInAllowedGroups?

> `optional` **shouldOnlyJoinInAllowedGroups**: `boolean`

### clientConfig.telegram.allowedGroupIds?

> `optional` **allowedGroupIds**: `string`[]

### clientConfig.telegram.messageSimilarityThreshold?

> `optional` **messageSimilarityThreshold**: `number`

### clientConfig.telegram.isPartOfTeam?

> `optional` **isPartOfTeam**: `boolean`

### clientConfig.telegram.teamAgentIds?

> `optional` **teamAgentIds**: `string`[]

### clientConfig.telegram.teamLeaderId?

> `optional` **teamLeaderId**: `string`

### clientConfig.telegram.teamMemberInterestKeywords?

> `optional` **teamMemberInterestKeywords**: `string`[]

### clientConfig.slack?

> `optional` **slack**: `object`

### clientConfig.slack.shouldIgnoreBotMessages?

> `optional` **shouldIgnoreBotMessages**: `boolean`

### clientConfig.slack.shouldIgnoreDirectMessages?

> `optional` **shouldIgnoreDirectMessages**: `boolean`

### clientConfig.gitbook?

> `optional` **gitbook**: `object`

### clientConfig.gitbook.keywords?

> `optional` **keywords**: `object`

### clientConfig.gitbook.keywords.projectTerms?

> `optional` **projectTerms**: `string`[]

### clientConfig.gitbook.keywords.generalQueries?

> `optional` **generalQueries**: `string`[]

### clientConfig.gitbook.documentTriggers?

> `optional` **documentTriggers**: `string`[]

### style

> **style**: `object`

Writing style guides

### style.all

> **all**: `string`[]

### style.chat

> **chat**: `string`[]

### style.post

> **post**: `string`[]

### twitterProfile?

> `optional` **twitterProfile**: `object`

Optional Twitter profile

### twitterProfile.id

> **id**: `string`

### twitterProfile.username

> **username**: `string`

### twitterProfile.screenName

> **screenName**: `string`

### twitterProfile.bio

> **bio**: `string`

### twitterProfile.nicknames?

> `optional` **nicknames**: `string`[]

### nft?

> `optional` **nft**: `object`

Optional NFT prompt

### nft.prompt

> **prompt**: `string`

## Defined in

[packages/core/src/types.ts:671](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L671)
