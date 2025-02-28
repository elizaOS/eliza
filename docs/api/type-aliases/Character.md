[@elizaos/core v0.25.8](../index.md) / Character

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

### email?

> `optional` **email**: `string`

Optional email

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

> `optional` **goalsTemplate**: [`TemplateType`](TemplateType.md)

### templates.factsTemplate?

> `optional` **factsTemplate**: [`TemplateType`](TemplateType.md)

### templates.messageHandlerTemplate?

> `optional` **messageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.shouldRespondTemplate?

> `optional` **shouldRespondTemplate**: [`TemplateType`](TemplateType.md)

### templates.continueMessageHandlerTemplate?

> `optional` **continueMessageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.evaluationTemplate?

> `optional` **evaluationTemplate**: [`TemplateType`](TemplateType.md)

### templates.twitterSearchTemplate?

> `optional` **twitterSearchTemplate**: [`TemplateType`](TemplateType.md)

### templates.twitterActionTemplate?

> `optional` **twitterActionTemplate**: [`TemplateType`](TemplateType.md)

### templates.twitterPostTemplate?

> `optional` **twitterPostTemplate**: [`TemplateType`](TemplateType.md)

### templates.twitterMessageHandlerTemplate?

> `optional` **twitterMessageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.twitterShouldRespondTemplate?

> `optional` **twitterShouldRespondTemplate**: [`TemplateType`](TemplateType.md)

### templates.twitterVoiceHandlerTemplate?

> `optional` **twitterVoiceHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.instagramPostTemplate?

> `optional` **instagramPostTemplate**: [`TemplateType`](TemplateType.md)

### templates.instagramMessageHandlerTemplate?

> `optional` **instagramMessageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.instagramShouldRespondTemplate?

> `optional` **instagramShouldRespondTemplate**: [`TemplateType`](TemplateType.md)

### templates.farcasterPostTemplate?

> `optional` **farcasterPostTemplate**: [`TemplateType`](TemplateType.md)

### templates.lensPostTemplate?

> `optional` **lensPostTemplate**: [`TemplateType`](TemplateType.md)

### templates.farcasterMessageHandlerTemplate?

> `optional` **farcasterMessageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.lensMessageHandlerTemplate?

> `optional` **lensMessageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.farcasterShouldRespondTemplate?

> `optional` **farcasterShouldRespondTemplate**: [`TemplateType`](TemplateType.md)

### templates.lensShouldRespondTemplate?

> `optional` **lensShouldRespondTemplate**: [`TemplateType`](TemplateType.md)

### templates.telegramMessageHandlerTemplate?

> `optional` **telegramMessageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.telegramShouldRespondTemplate?

> `optional` **telegramShouldRespondTemplate**: [`TemplateType`](TemplateType.md)

### templates.telegramAutoPostTemplate?

> `optional` **telegramAutoPostTemplate**: `string`

### templates.telegramPinnedMessageTemplate?

> `optional` **telegramPinnedMessageTemplate**: `string`

### templates.discordAutoPostTemplate?

> `optional` **discordAutoPostTemplate**: `string`

### templates.discordAnnouncementHypeTemplate?

> `optional` **discordAnnouncementHypeTemplate**: `string`

### templates.discordVoiceHandlerTemplate?

> `optional` **discordVoiceHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.discordShouldRespondTemplate?

> `optional` **discordShouldRespondTemplate**: [`TemplateType`](TemplateType.md)

### templates.discordMessageHandlerTemplate?

> `optional` **discordMessageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.slackMessageHandlerTemplate?

> `optional` **slackMessageHandlerTemplate**: [`TemplateType`](TemplateType.md)

### templates.slackShouldRespondTemplate?

> `optional` **slackShouldRespondTemplate**: [`TemplateType`](TemplateType.md)

### templates.jeeterPostTemplate?

> `optional` **jeeterPostTemplate**: `string`

### templates.jeeterSearchTemplate?

> `optional` **jeeterSearchTemplate**: `string`

### templates.jeeterInteractionTemplate?

> `optional` **jeeterInteractionTemplate**: `string`

### templates.jeeterMessageHandlerTemplate?

> `optional` **jeeterMessageHandlerTemplate**: `string`

### templates.jeeterShouldRespondTemplate?

> `optional` **jeeterShouldRespondTemplate**: `string`

### templates.devaPostTemplate?

> `optional` **devaPostTemplate**: `string`

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

> `optional` **knowledge**: (`string` \| `object` \| `object`)[]

Optional knowledge base

### plugins

> **plugins**: [`Plugin`](Plugin.md)[]

Available plugins

### postProcessors?

> `optional` **postProcessors**: `Pick`\<[`Plugin`](Plugin.md), `"name"` \| `"description"` \| `"handlePostCharacterLoaded"`\>[]

Character Processor Plugins

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

### settings.imageSettings.cfgScale?

> `optional` **cfgScale**: `number`

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

### settings.imageSettings.safeMode?

> `optional` **safeMode**: `boolean`

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

### settings.ragKnowledge?

> `optional` **ragKnowledge**: `boolean`

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

### clientConfig.discord.autoPost?

> `optional` **autoPost**: `object`

### clientConfig.discord.autoPost.enabled?

> `optional` **enabled**: `boolean`

### clientConfig.discord.autoPost.monitorTime?

> `optional` **monitorTime**: `number`

### clientConfig.discord.autoPost.inactivityThreshold?

> `optional` **inactivityThreshold**: `number`

### clientConfig.discord.autoPost.mainChannelId?

> `optional` **mainChannelId**: `string`

### clientConfig.discord.autoPost.announcementChannelIds?

> `optional` **announcementChannelIds**: `string`[]

### clientConfig.discord.autoPost.minTimeBetweenPosts?

> `optional` **minTimeBetweenPosts**: `number`

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

### clientConfig.telegram.autoPost?

> `optional` **autoPost**: `object`

### clientConfig.telegram.autoPost.enabled?

> `optional` **enabled**: `boolean`

### clientConfig.telegram.autoPost.monitorTime?

> `optional` **monitorTime**: `number`

### clientConfig.telegram.autoPost.inactivityThreshold?

> `optional` **inactivityThreshold**: `number`

### clientConfig.telegram.autoPost.mainChannelId?

> `optional` **mainChannelId**: `string`

### clientConfig.telegram.autoPost.pinnedMessagesGroups?

> `optional` **pinnedMessagesGroups**: `string`[]

### clientConfig.telegram.autoPost.minTimeBetweenPosts?

> `optional` **minTimeBetweenPosts**: `number`

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

### instagramProfile?

> `optional` **instagramProfile**: `object`

Optional Instagram profile

### instagramProfile.id

> **id**: `string`

### instagramProfile.username

> **username**: `string`

### instagramProfile.bio

> **bio**: `string`

### instagramProfile.nicknames?

> `optional` **nicknames**: `string`[]

### simsaiProfile?

> `optional` **simsaiProfile**: `object`

Optional SimsAI profile

### simsaiProfile.id

> **id**: `string`

### simsaiProfile.username

> **username**: `string`

### simsaiProfile.screenName

> **screenName**: `string`

### simsaiProfile.bio

> **bio**: `string`

### nft?

> `optional` **nft**: `object`

Optional NFT prompt

### nft.prompt

> **prompt**: `string`

### extends?

> `optional` **extends**: `string`[]

Optinal Parent characters to inherit information from

### twitterSpaces?

> `optional` **twitterSpaces**: [`TwitterSpaceDecisionOptions`](../interfaces/TwitterSpaceDecisionOptions.md)

## Defined in

[packages/core/src/types.ts:728](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L728)
