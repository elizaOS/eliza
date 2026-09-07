/** Generated public route contracts. Regenerate with scripts/generate-public-routes.mjs. */
import type { CloudResponse } from "../types.js";
import { PublicRouteTransport } from "./transport.js";
import type { PublicRouteCallOptions } from "./types.generated.js";

export class ElizaCloudPublicRoutesClient extends PublicRouteTransport {
  deleteApiElevenlabsVoicesById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/elevenlabs/voices/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/elevenlabs/voices/{id}", TResponse>(
      "DELETE /api/elevenlabs/voices/{id}",
      options,
    );
  }

  deleteApiV1AdvertisingAccountsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/accounts/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/advertising/accounts/{id}", TResponse>(
      "DELETE /api/v1/advertising/accounts/{id}",
      options,
    );
  }

  deleteApiV1AdvertisingAudienceSegmentsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/audience-segments/{id}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/advertising/audience-segments/{id}",
      TResponse
    >("DELETE /api/v1/advertising/audience-segments/{id}", options);
  }

  deleteApiV1AdvertisingCampaignsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/campaigns/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/advertising/campaigns/{id}", TResponse>(
      "DELETE /api/v1/advertising/campaigns/{id}",
      options,
    );
  }

  deleteApiV1AdvertisingCampaignsByIdReportShareByShareId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/campaigns/{id}/report/share/{shareId}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/advertising/campaigns/{id}/report/share/{shareId}",
      TResponse
    >(
      "DELETE /api/v1/advertising/campaigns/{id}/report/share/{shareId}",
      options,
    );
  }

  deleteApiV1AdvertisingCreativesById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/creatives/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/advertising/creatives/{id}", TResponse>(
      "DELETE /api/v1/advertising/creatives/{id}",
      options,
    );
  }

  deleteApiV1AgentsByAgentIdPublish<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/agents/{agentId}/publish">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/agents/{agentId}/publish", TResponse>(
      "DELETE /api/v1/agents/{agentId}/publish",
      options,
    );
  }

  deleteApiV1AgentsByAgentIdWorkflowsByWorkflowId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/agents/{agentId}/workflows/{workflowId}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/agents/{agentId}/workflows/{workflowId}",
      TResponse
    >("DELETE /api/v1/agents/{agentId}/workflows/{workflowId}", options);
  }

  deleteApiV1ApiKeysById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/api-keys/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/api-keys/{id}", TResponse>(
      "DELETE /api/v1/api-keys/{id}",
      options,
    );
  }

  deleteApiV1ApiKeysCurrent<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/api-keys/current"> = {},
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/api-keys/current", TResponse>(
      "DELETE /api/v1/api-keys/current",
      options,
    );
  }

  deleteApiV1ApisStorageObjects<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/apis/storage/objects/_">,
  ): Promise<CloudResponse<TResponse>> {
    return this.callBodyless<
      "DELETE /api/v1/apis/storage/objects/_",
      TResponse
    >("DELETE /api/v1/apis/storage/objects/_", options);
  }

  deleteApiV1AppAuthMobileCredentialsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/app-auth/mobile/credentials/{id}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/app-auth/mobile/credentials/{id}",
      TResponse
    >("DELETE /api/v1/app-auth/mobile/credentials/{id}", options);
  }

  deleteApiV1AppsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/apps/{id}", TResponse>(
      "DELETE /api/v1/apps/{id}",
      options,
    );
  }

  deleteApiV1AppsByIdDiscordAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/discord-automation">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/apps/{id}/discord-automation", TResponse>(
      "DELETE /api/v1/apps/{id}/discord-automation",
      options,
    );
  }

  deleteApiV1AppsByIdDomains<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/domains">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/apps/{id}/domains", TResponse>(
      "DELETE /api/v1/apps/{id}/domains",
      options,
    );
  }

  deleteApiV1AppsByIdDomainsByDomainDnsByRecordId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/domains/{domain}/dns/{recordId}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/apps/{id}/domains/{domain}/dns/{recordId}",
      TResponse
    >("DELETE /api/v1/apps/{id}/domains/{domain}/dns/{recordId}", options);
  }

  deleteApiV1AppsByIdFrontendByDeploymentId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/frontend/{deploymentId}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/apps/{id}/frontend/{deploymentId}",
      TResponse
    >("DELETE /api/v1/apps/{id}/frontend/{deploymentId}", options);
  }

  deleteApiV1AppsByIdTelegramAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/telegram-automation">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/apps/{id}/telegram-automation", TResponse>(
      "DELETE /api/v1/apps/{id}/telegram-automation",
      options,
    );
  }

  deleteApiV1AppsByIdTwitterAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/twitter-automation">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/apps/{id}/twitter-automation", TResponse>(
      "DELETE /api/v1/apps/{id}/twitter-automation",
      options,
    );
  }

  deleteApiV1BlooioDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/blooio/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/blooio/disconnect", TResponse>(
      "DELETE /api/v1/blooio/disconnect",
      options,
    );
  }

  deleteApiV1BrowserSessionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/browser/sessions/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/browser/sessions/{id}", TResponse>(
      "DELETE /api/v1/browser/sessions/{id}",
      options,
    );
  }

  deleteApiV1ConnectionsByPlatform<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/connections/{platform}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/connections/{platform}", TResponse>(
      "DELETE /api/v1/connections/{platform}",
      options,
    );
  }

  deleteApiV1ContainersById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/containers/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/containers/{id}", TResponse>(
      "DELETE /api/v1/containers/{id}",
      options,
    );
  }

  deleteApiV1DiscordConnectionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/discord/connections/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/discord/connections/{id}", TResponse>(
      "DELETE /api/v1/discord/connections/{id}",
      options,
    );
  }

  deleteApiV1DocumentsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/documents/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/documents/{id}", TResponse>(
      "DELETE /api/v1/documents/{id}",
      options,
    );
  }

  deleteApiV1DocumentsPreUpload<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/documents/pre-upload"> = {},
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/documents/pre-upload", TResponse>(
      "DELETE /api/v1/documents/pre-upload",
      options,
    );
  }

  deleteApiV1ElizaAgentsByAgentId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/eliza/agents/{agentId}", TResponse>(
      "DELETE /api/v1/eliza/agents/{agentId}",
      options,
    );
  }

  deleteApiV1ElizaAgentsByAgentIdApiByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/eliza/agents/{agentId}/api/{path}",
      TResponse
    >("DELETE /api/v1/eliza/agents/{agentId}/api/{path}", options);
  }

  deleteApiV1ElizaAgentsByAgentIdApiConversationsByConversationId<
    TResponse = unknown,
  >(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}",
      TResponse
    >(
      "DELETE /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}",
      options,
    );
  }

  deleteApiV1ElizaAgentsByAgentIdDiscord<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}/discord">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/eliza/agents/{agentId}/discord",
      TResponse
    >("DELETE /api/v1/eliza/agents/{agentId}/discord", options);
  }

  deleteApiV1ElizaAgentsByAgentIdGithub<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}/github">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/eliza/agents/{agentId}/github", TResponse>(
      "DELETE /api/v1/eliza/agents/{agentId}/github",
      options,
    );
  }

  deleteApiV1ElizaGatewayRelaySessionsBySessionId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/gateway-relay/sessions/{sessionId}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/eliza/gateway-relay/sessions/{sessionId}",
      TResponse
    >("DELETE /api/v1/eliza/gateway-relay/sessions/{sessionId}", options);
  }

  deleteApiV1ElizaGoogleCalendarEventsByEventId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/google/calendar/events/{eventId}">,
  ): Promise<TResponse> {
    return this.call<
      "DELETE /api/v1/eliza/google/calendar/events/{eventId}",
      TResponse
    >("DELETE /api/v1/eliza/google/calendar/events/{eventId}", options);
  }

  deleteApiV1FilesById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/files/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/files/{id}", TResponse>(
      "DELETE /api/v1/files/{id}",
      options,
    );
  }

  deleteApiV1GalleryById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/gallery/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/gallery/{id}", TResponse>(
      "DELETE /api/v1/gallery/{id}",
      options,
    );
  }

  deleteApiV1MarketingInventoryBySlotId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/marketing/inventory/{slotId}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/marketing/inventory/{slotId}", TResponse>(
      "DELETE /api/v1/marketing/inventory/{slotId}",
      options,
    );
  }

  deleteApiV1McpsByMcpId<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/mcps/{mcpId}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/mcps/{mcpId}", TResponse>(
      "DELETE /api/v1/mcps/{mcpId}",
      options,
    );
  }

  deleteApiV1McpsByMcpIdPublish<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/mcps/{mcpId}/publish">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/mcps/{mcpId}/publish", TResponse>(
      "DELETE /api/v1/mcps/{mcpId}/publish",
      options,
    );
  }

  deleteApiV1OauthConnectionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/oauth/connections/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/oauth/connections/{id}", TResponse>(
      "DELETE /api/v1/oauth/connections/{id}",
      options,
    );
  }

  deleteApiV1ProxyBirdeyeByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/proxy/birdeye/{path}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/proxy/birdeye/{path}", TResponse>(
      "DELETE /api/v1/proxy/birdeye/{path}",
      options,
    );
  }

  deleteApiV1RemoteSessionsByIdActivate<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/remote/sessions/{id}/activate">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/remote/sessions/{id}/activate", TResponse>(
      "DELETE /api/v1/remote/sessions/{id}/activate",
      options,
    );
  }

  deleteApiV1SessionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/sessions/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/sessions/{id}", TResponse>(
      "DELETE /api/v1/sessions/{id}",
      options,
    );
  }

  deleteApiV1TelegramDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/telegram/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/telegram/disconnect", TResponse>(
      "DELETE /api/v1/telegram/disconnect",
      options,
    );
  }

  deleteApiV1TwilioDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/twilio/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/twilio/disconnect", TResponse>(
      "DELETE /api/v1/twilio/disconnect",
      options,
    );
  }

  deleteApiV1TwilioVoiceCallsByCallSid<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/twilio/voice/calls/{callSid}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/twilio/voice/calls/{callSid}", TResponse>(
      "DELETE /api/v1/twilio/voice/calls/{callSid}",
      options,
    );
  }

  deleteApiV1TwitterDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/twitter/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/twitter/disconnect", TResponse>(
      "DELETE /api/v1/twitter/disconnect",
      options,
    );
  }

  deleteApiV1VoiceById<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/voice/{id}">,
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/voice/{id}", TResponse>(
      "DELETE /api/v1/voice/{id}",
      options,
    );
  }

  deleteApiV1WebPushSubscriptions<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/web-push/subscriptions"> = {},
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/web-push/subscriptions", TResponse>(
      "DELETE /api/v1/web-push/subscriptions",
      options,
    );
  }

  deleteApiV1WhatsappDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"DELETE /api/v1/whatsapp/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"DELETE /api/v1/whatsapp/disconnect", TResponse>(
      "DELETE /api/v1/whatsapp/disconnect",
      options,
    );
  }

  getApiElevenlabsVoices<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/elevenlabs/voices", TResponse>(
      "GET /api/elevenlabs/voices",
      options,
    );
  }

  getApiElevenlabsVoicesById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/elevenlabs/voices/{id}", TResponse>(
      "GET /api/elevenlabs/voices/{id}",
      options,
    );
  }

  getApiElevenlabsVoicesJobs<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices/jobs"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/elevenlabs/voices/jobs", TResponse>(
      "GET /api/elevenlabs/voices/jobs",
      options,
    );
  }

  getApiElevenlabsVoicesUser<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices/user"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/elevenlabs/voices/user", TResponse>(
      "GET /api/elevenlabs/voices/user",
      options,
    );
  }

  getApiElevenlabsVoicesVerifyById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices/verify/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/elevenlabs/voices/verify/{id}", TResponse>(
      "GET /api/elevenlabs/voices/verify/{id}",
      options,
    );
  }

  getApiV1AdvertisingAccounts<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/accounts"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/advertising/accounts", TResponse>(
      "GET /api/v1/advertising/accounts",
      options,
    );
  }

  getApiV1AdvertisingAccountsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/accounts/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/advertising/accounts/{id}", TResponse>(
      "GET /api/v1/advertising/accounts/{id}",
      options,
    );
  }

  getApiV1AdvertisingAccountsByIdMedia<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/accounts/{id}/media">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/advertising/accounts/{id}/media", TResponse>(
      "GET /api/v1/advertising/accounts/{id}/media",
      options,
    );
  }

  getApiV1AdvertisingAudienceSegments<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/audience-segments"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/advertising/audience-segments", TResponse>(
      "GET /api/v1/advertising/audience-segments",
      options,
    );
  }

  getApiV1AdvertisingAudienceSegmentsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/audience-segments/{id}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/advertising/audience-segments/{id}",
      TResponse
    >("GET /api/v1/advertising/audience-segments/{id}", options);
  }

  getApiV1AdvertisingCampaigns<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/advertising/campaigns", TResponse>(
      "GET /api/v1/advertising/campaigns",
      options,
    );
  }

  getApiV1AdvertisingCampaignsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/advertising/campaigns/{id}", TResponse>(
      "GET /api/v1/advertising/campaigns/{id}",
      options,
    );
  }

  getApiV1AdvertisingCampaignsByIdAnalytics<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/analytics">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/advertising/campaigns/{id}/analytics",
      TResponse
    >("GET /api/v1/advertising/campaigns/{id}/analytics", options);
  }

  getApiV1AdvertisingCampaignsByIdAttribution<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/attribution">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/advertising/campaigns/{id}/attribution",
      TResponse
    >("GET /api/v1/advertising/campaigns/{id}/attribution", options);
  }

  getApiV1AdvertisingCampaignsByIdCreatives<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/creatives">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/advertising/campaigns/{id}/creatives",
      TResponse
    >("GET /api/v1/advertising/campaigns/{id}/creatives", options);
  }

  getApiV1AdvertisingCampaignsByIdDayparting<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/dayparting">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/advertising/campaigns/{id}/dayparting",
      TResponse
    >("GET /api/v1/advertising/campaigns/{id}/dayparting", options);
  }

  getApiV1AdvertisingCampaignsByIdReport<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/report">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/advertising/campaigns/{id}/report",
      TResponse
    >("GET /api/v1/advertising/campaigns/{id}/report", options);
  }

  getApiV1AdvertisingConversionsTrack<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/conversions/track"> = {},
  ): Promise<CloudResponse<TResponse>> {
    return this.callBodyless<
      "GET /api/v1/advertising/conversions/track",
      TResponse
    >("GET /api/v1/advertising/conversions/track", options);
  }

  getApiV1AdvertisingCreativesById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/creatives/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/advertising/creatives/{id}", TResponse>(
      "GET /api/v1/advertising/creatives/{id}",
      options,
    );
  }

  getApiV1AdvertisingReportsByToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/reports/{token}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/advertising/reports/{token}", TResponse>(
      "GET /api/v1/advertising/reports/{token}",
      options,
    );
  }

  getApiV1Affiliates<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/affiliates"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/affiliates", TResponse>(
      "GET /api/v1/affiliates",
      options,
    );
  }

  getApiV1AgentsByAgentId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/agents/{agentId}", TResponse>(
      "GET /api/v1/agents/{agentId}",
      options,
    );
  }

  getApiV1AgentsByAgentIdLogs<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/logs">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/agents/{agentId}/logs", TResponse>(
      "GET /api/v1/agents/{agentId}/logs",
      options,
    );
  }

  getApiV1AgentsByAgentIdMonetization<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/monetization">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/agents/{agentId}/monetization", TResponse>(
      "GET /api/v1/agents/{agentId}/monetization",
      options,
    );
  }

  getApiV1AgentsByAgentIdStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/status">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/agents/{agentId}/status", TResponse>(
      "GET /api/v1/agents/{agentId}/status",
      options,
    );
  }

  getApiV1AgentsByAgentIdUsage<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/usage">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/agents/{agentId}/usage", TResponse>(
      "GET /api/v1/agents/{agentId}/usage",
      options,
    );
  }

  getApiV1AgentsByAgentIdWorkflows<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/workflows">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/agents/{agentId}/workflows", TResponse>(
      "GET /api/v1/agents/{agentId}/workflows",
      options,
    );
  }

  getApiV1AgentsByAgentIdWorkflowsByWorkflowId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/workflows/{workflowId}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/agents/{agentId}/workflows/{workflowId}",
      TResponse
    >("GET /api/v1/agents/{agentId}/workflows/{workflowId}", options);
  }

  getApiV1AgentsByAgentIdWorkflowsExecutionsByExecutionId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/workflows/executions/{executionId}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/agents/{agentId}/workflows/executions/{executionId}",
      TResponse
    >(
      "GET /api/v1/agents/{agentId}/workflows/executions/{executionId}",
      options,
    );
  }

  getApiV1AgentsByToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/agents/by-token"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/agents/by-token", TResponse>(
      "GET /api/v1/agents/by-token",
      options,
    );
  }

  getApiV1ApiKeys<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/api-keys"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/api-keys", TResponse>(
      "GET /api/v1/api-keys",
      options,
    );
  }

  getApiV1ApisBirdeyeByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apis/birdeye/{path}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apis/birdeye/{path}", TResponse>(
      "GET /api/v1/apis/birdeye/{path}",
      options,
    );
  }

  getApiV1ApisDexscreenerByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apis/dexscreener/{path}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apis/dexscreener/{path}", TResponse>(
      "GET /api/v1/apis/dexscreener/{path}",
      options,
    );
  }

  getApiV1ApisStorageList<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apis/storage/list">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apis/storage/list", TResponse>(
      "GET /api/v1/apis/storage/list",
      options,
    );
  }

  getApiV1ApisStorageObjects(
    options: PublicRouteCallOptions<"GET /api/v1/apis/storage/objects/_">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apis/storage/objects/_", options);
  }

  getApiV1AppAuthMobileConfig<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/app-auth/mobile/config"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/app-auth/mobile/config", TResponse>(
      "GET /api/v1/app-auth/mobile/config",
      options,
    );
  }

  getApiV1AppAuthMobileCredentials<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/app-auth/mobile/credentials"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/app-auth/mobile/credentials", TResponse>(
      "GET /api/v1/app-auth/mobile/credentials",
      options,
    );
  }

  getApiV1AppAuthSession<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/app-auth/session"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/app-auth/session", TResponse>(
      "GET /api/v1/app-auth/session",
      options,
    );
  }

  getApiV1AppCreditsBalance<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/app-credits/balance"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/app-credits/balance", TResponse>(
      "GET /api/v1/app-credits/balance",
      options,
    );
  }

  getApiV1AppCreditsVerify<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/app-credits/verify"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/app-credits/verify", TResponse>(
      "GET /api/v1/app-credits/verify",
      options,
    );
  }

  getApiV1ApprovalRequests<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/approval-requests"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/approval-requests", TResponse>(
      "GET /api/v1/approval-requests",
      options,
    );
  }

  getApiV1ApprovalRequestsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/approval-requests/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/approval-requests/{id}", TResponse>(
      "GET /api/v1/approval-requests/{id}",
      options,
    );
  }

  getApiV1Apps<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps", TResponse>(
      "GET /api/v1/apps",
      options,
    );
  }

  getApiV1AppsIngressAsk(
    options: PublicRouteCallOptions<"GET /api/v1/apps-ingress/ask"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps-ingress/ask", options);
  }

  getApiV1AppsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}", TResponse>(
      "GET /api/v1/apps/{id}",
      options,
    );
  }

  getApiV1AppsByIdAnalytics<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/analytics">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/analytics", TResponse>(
      "GET /api/v1/apps/{id}/analytics",
      options,
    );
  }

  getApiV1AppsByIdAnalyticsRequests<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/analytics/requests">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/analytics/requests", TResponse>(
      "GET /api/v1/apps/{id}/analytics/requests",
      options,
    );
  }

  getApiV1AppsByIdBackup<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/backup">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/backup", TResponse>(
      "GET /api/v1/apps/{id}/backup",
      options,
    );
  }

  getApiV1AppsByIdBillingAccount<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/billing/account">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/billing/account", TResponse>(
      "GET /api/v1/apps/{id}/billing/account",
      options,
    );
  }

  getApiV1AppsByIdCharacters<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/characters">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/characters", TResponse>(
      "GET /api/v1/apps/{id}/characters",
      options,
    );
  }

  getApiV1AppsByIdCharges<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/charges">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/charges", TResponse>(
      "GET /api/v1/apps/{id}/charges",
      options,
    );
  }

  getApiV1AppsByIdChargesByChargeId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/charges/{chargeId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/charges/{chargeId}", TResponse>(
      "GET /api/v1/apps/{id}/charges/{chargeId}",
      options,
    );
  }

  getApiV1AppsByIdDatabase<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/database">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/database", TResponse>(
      "GET /api/v1/apps/{id}/database",
      options,
    );
  }

  getApiV1AppsByIdDeployStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/deploy/status">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/deploy/status", TResponse>(
      "GET /api/v1/apps/{id}/deploy/status",
      options,
    );
  }

  getApiV1AppsByIdDiscordAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/discord-automation">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/discord-automation", TResponse>(
      "GET /api/v1/apps/{id}/discord-automation",
      options,
    );
  }

  getApiV1AppsByIdDomains<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/domains">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/domains", TResponse>(
      "GET /api/v1/apps/{id}/domains",
      options,
    );
  }

  getApiV1AppsByIdDomainsByDomainDns<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/domains/{domain}/dns">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/domains/{domain}/dns", TResponse>(
      "GET /api/v1/apps/{id}/domains/{domain}/dns",
      options,
    );
  }

  getApiV1AppsByIdDomainsByDomainDnsByRecordId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/domains/{domain}/dns/{recordId}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/apps/{id}/domains/{domain}/dns/{recordId}",
      TResponse
    >("GET /api/v1/apps/{id}/domains/{domain}/dns/{recordId}", options);
  }

  getApiV1AppsByIdEarnings<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/earnings">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/earnings", TResponse>(
      "GET /api/v1/apps/{id}/earnings",
      options,
    );
  }

  getApiV1AppsByIdEarningsHistory<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/earnings/history">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/earnings/history", TResponse>(
      "GET /api/v1/apps/{id}/earnings/history",
      options,
    );
  }

  getApiV1AppsByIdFrontend<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/frontend">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/frontend", TResponse>(
      "GET /api/v1/apps/{id}/frontend",
      options,
    );
  }

  getApiV1AppsByIdFrontendByDeploymentId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/frontend/{deploymentId}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/apps/{id}/frontend/{deploymentId}",
      TResponse
    >("GET /api/v1/apps/{id}/frontend/{deploymentId}", options);
  }

  getApiV1AppsByIdFrontendPreviewByPath(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/frontend/preview/{[...path]}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/apps/{id}/frontend/preview/{[...path]}",
      options,
    );
  }

  getApiV1AppsByIdMonetization<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/monetization">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/monetization", TResponse>(
      "GET /api/v1/apps/{id}/monetization",
      options,
    );
  }

  getApiV1AppsByIdPromote<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/promote">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/promote", TResponse>(
      "GET /api/v1/apps/{id}/promote",
      options,
    );
  }

  getApiV1AppsByIdPromoteAnalytics<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/promote/analytics">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/promote/analytics", TResponse>(
      "GET /api/v1/apps/{id}/promote/analytics",
      options,
    );
  }

  getApiV1AppsByIdPromoteAssets<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/promote/assets">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/promote/assets", TResponse>(
      "GET /api/v1/apps/{id}/promote/assets",
      options,
    );
  }

  getApiV1AppsByIdPublic<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/public">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/public", TResponse>(
      "GET /api/v1/apps/{id}/public",
      options,
    );
  }

  getApiV1AppsByIdReview<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/review">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/review", TResponse>(
      "GET /api/v1/apps/{id}/review",
      options,
    );
  }

  getApiV1AppsByIdTelegramAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/telegram-automation">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/telegram-automation", TResponse>(
      "GET /api/v1/apps/{id}/telegram-automation",
      options,
    );
  }

  getApiV1AppsByIdTwitterAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/twitter-automation">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/twitter-automation", TResponse>(
      "GET /api/v1/apps/{id}/twitter-automation",
      options,
    );
  }

  getApiV1AppsByIdUsers<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/users">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/apps/{id}/users", TResponse>(
      "GET /api/v1/apps/{id}/users",
      options,
    );
  }

  getApiV1Ballots<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/ballots"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/ballots", TResponse>(
      "GET /api/v1/ballots",
      options,
    );
  }

  getApiV1BallotsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/ballots/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/ballots/{id}", TResponse>(
      "GET /api/v1/ballots/{id}",
      options,
    );
  }

  getApiV1BillingActive<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/billing/active"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/billing/active", TResponse>(
      "GET /api/v1/billing/active",
      options,
    );
  }

  getApiV1BillingLedger<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/billing/ledger"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/billing/ledger", TResponse>(
      "GET /api/v1/billing/ledger",
      options,
    );
  }

  getApiV1BillingLimits<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/billing/limits"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/billing/limits", TResponse>(
      "GET /api/v1/billing/limits",
      options,
    );
  }

  getApiV1BillingResourcesByIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/billing/resources/{id}/cancel">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/billing/resources/{id}/cancel", TResponse>(
      "GET /api/v1/billing/resources/{id}/cancel",
      options,
    );
  }

  getApiV1BillingSettings<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/billing/settings"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/billing/settings", TResponse>(
      "GET /api/v1/billing/settings",
      options,
    );
  }

  getApiV1BlooioStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/blooio/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/blooio/status", TResponse>(
      "GET /api/v1/blooio/status",
      options,
    );
  }

  getApiV1BrowserSessions<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/browser/sessions"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/browser/sessions", TResponse>(
      "GET /api/v1/browser/sessions",
      options,
    );
  }

  getApiV1BrowserSessionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/browser/sessions/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/browser/sessions/{id}", TResponse>(
      "GET /api/v1/browser/sessions/{id}",
      options,
    );
  }

  getApiV1BrowserSessionsByIdSnapshot<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/browser/sessions/{id}/snapshot">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/browser/sessions/{id}/snapshot", TResponse>(
      "GET /api/v1/browser/sessions/{id}/snapshot",
      options,
    );
  }

  getApiV1ChainNftsByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/chain/nfts/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/chain/nfts/{chain}/{address}", TResponse>(
      "GET /api/v1/chain/nfts/{chain}/{address}",
      options,
    );
  }

  getApiV1ChainTokensByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/chain/tokens/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/chain/tokens/{chain}/{address}", TResponse>(
      "GET /api/v1/chain/tokens/{chain}/{address}",
      options,
    );
  }

  getApiV1ChainTransfersByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/chain/transfers/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/chain/transfers/{chain}/{address}",
      TResponse
    >("GET /api/v1/chain/transfers/{chain}/{address}", options);
  }

  getApiV1CliAuthBySessionToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/cli-auth/{session}/token">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/cli-auth/{session}/token", TResponse>(
      "GET /api/v1/cli-auth/{session}/token",
      options,
    );
  }

  getApiV1ConnectionsByPlatform<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/connections/{platform}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/connections/{platform}", TResponse>(
      "GET /api/v1/connections/{platform}",
      options,
    );
  }

  getApiV1ConnectionsAccounts<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/connections/accounts"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/connections/accounts", TResponse>(
      "GET /api/v1/connections/accounts",
      options,
    );
  }

  getApiV1ConnectionsAccountsByAccountId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/connections/accounts/{accountId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/connections/accounts/{accountId}", TResponse>(
      "GET /api/v1/connections/accounts/{accountId}",
      options,
    );
  }

  getApiV1Containers<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/containers"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/containers", TResponse>(
      "GET /api/v1/containers",
      options,
    );
  }

  getApiV1CreditsBalance<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/credits/balance"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/credits/balance", TResponse>(
      "GET /api/v1/credits/balance",
      options,
    );
  }

  getApiV1CreditsSummary<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/credits/summary"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/credits/summary", TResponse>(
      "GET /api/v1/credits/summary",
      options,
    );
  }

  getApiV1CreditsVerify<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/credits/verify"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/credits/verify", TResponse>(
      "GET /api/v1/credits/verify",
      options,
    );
  }

  getApiV1DeviceBusDevicesByDeviceIdIntents<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/device-bus/devices/{deviceId}/intents">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/device-bus/devices/{deviceId}/intents",
      TResponse
    >("GET /api/v1/device-bus/devices/{deviceId}/intents", options);
  }

  getApiV1DiscordCallback<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/discord/callback"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/discord/callback", TResponse>(
      "GET /api/v1/discord/callback",
      options,
    );
  }

  getApiV1DiscordChannels<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/discord/channels"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/discord/channels", TResponse>(
      "GET /api/v1/discord/channels",
      options,
    );
  }

  getApiV1DiscordConnections<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/discord/connections"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/discord/connections", TResponse>(
      "GET /api/v1/discord/connections",
      options,
    );
  }

  getApiV1DiscordConnectionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/discord/connections/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/discord/connections/{id}", TResponse>(
      "GET /api/v1/discord/connections/{id}",
      options,
    );
  }

  getApiV1DiscordGuilds<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/discord/guilds"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/discord/guilds", TResponse>(
      "GET /api/v1/discord/guilds",
      options,
    );
  }

  getApiV1DiscordOauth<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/discord/oauth"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/discord/oauth", TResponse>(
      "GET /api/v1/discord/oauth",
      options,
    );
  }

  getApiV1DiscordStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/discord/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/discord/status", TResponse>(
      "GET /api/v1/discord/status",
      options,
    );
  }

  getApiV1Discovery<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/discovery"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/discovery", TResponse>(
      "GET /api/v1/discovery",
      options,
    );
  }

  getApiV1Documents<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/documents"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/documents", TResponse>(
      "GET /api/v1/documents",
      options,
    );
  }

  getApiV1DocumentsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/documents/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/documents/{id}", TResponse>(
      "GET /api/v1/documents/{id}",
      options,
    );
  }

  getApiV1DocumentsCheck<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/documents/check"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/documents/check", TResponse>(
      "GET /api/v1/documents/check",
      options,
    );
  }

  getApiV1Domains<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/domains"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/domains", TResponse>(
      "GET /api/v1/domains",
      options,
    );
  }

  getApiV1DomainsResolve<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/domains/resolve"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/domains/resolve", TResponse>(
      "GET /api/v1/domains/resolve",
      options,
    );
  }

  getApiV1ElizaAgents<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/agents", TResponse>(
      "GET /api/v1/eliza/agents",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/agents/{agentId}", TResponse>(
      "GET /api/v1/eliza/agents/{agentId}",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdApiByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/api/{path}",
      TResponse
    >("GET /api/v1/eliza/agents/{agentId}/api/{path}", options);
  }

  getApiV1ElizaAgentsByAgentIdApiConversations<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/conversations">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/api/conversations",
      TResponse
    >("GET /api/v1/eliza/agents/{agentId}/api/conversations", options);
  }

  getApiV1ElizaAgentsByAgentIdApiConversationsByConversationIdMessages<
    TResponse = unknown,
  >(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages",
      TResponse
    >(
      "GET /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdApiHealth<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/health">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/api/health",
      TResponse
    >("GET /api/v1/eliza/agents/{agentId}/api/health", options);
  }

  getApiV1ElizaAgentsByAgentIdApiIdentity<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/identity">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/api/identity",
      TResponse
    >("GET /api/v1/eliza/agents/{agentId}/api/identity", options);
  }

  getApiV1ElizaAgentsByAgentIdApiIdentityOnchain<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/identity/onchain">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/api/identity/onchain",
      TResponse
    >("GET /api/v1/eliza/agents/{agentId}/api/identity/onchain", options);
  }

  getApiV1ElizaAgentsByAgentIdApiWalletByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/wallet/{path}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/api/wallet/{path}",
      TResponse
    >("GET /api/v1/eliza/agents/{agentId}/api/wallet/{path}", options);
  }

  getApiV1ElizaAgentsByAgentIdBackups<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/backups">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/agents/{agentId}/backups", TResponse>(
      "GET /api/v1/eliza/agents/{agentId}/backups",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdDiscord<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/discord">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/agents/{agentId}/discord", TResponse>(
      "GET /api/v1/eliza/agents/{agentId}/discord",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdGithub<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/github">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/agents/{agentId}/github", TResponse>(
      "GET /api/v1/eliza/agents/{agentId}/github",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdGithubToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/github/token">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/github/token",
      TResponse
    >("GET /api/v1/eliza/agents/{agentId}/github/token", options);
  }

  getApiV1ElizaAgentsByAgentIdLifeopsScheduleMergedState<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/lifeops/schedule/merged-state">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/lifeops/schedule/merged-state",
      TResponse
    >(
      "GET /api/v1/eliza/agents/{agentId}/lifeops/schedule/merged-state",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdUpgradeTier<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/upgrade-tier">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/upgrade-tier",
      TResponse
    >("GET /api/v1/eliza/agents/{agentId}/upgrade-tier", options);
  }

  getApiV1ElizaAgentsByAgentIdUpgradeTierAdoptExisting<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing",
      TResponse
    >(
      "GET /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdWallet<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/wallet">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/agents/{agentId}/wallet", TResponse>(
      "GET /api/v1/eliza/agents/{agentId}/wallet",
      options,
    );
  }

  getApiV1ElizaGatewayRelaySessionsBySessionIdNext<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/gateway-relay/sessions/{sessionId}/next">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/gateway-relay/sessions/{sessionId}/next",
      TResponse
    >("GET /api/v1/eliza/gateway-relay/sessions/{sessionId}/next", options);
  }

  getApiV1ElizaGithubOauthComplete<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/github-oauth-complete"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/github-oauth-complete", TResponse>(
      "GET /api/v1/eliza/github-oauth-complete",
      options,
    );
  }

  getApiV1ElizaGoogleAccounts<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/accounts"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/google/accounts", TResponse>(
      "GET /api/v1/eliza/google/accounts",
      options,
    );
  }

  getApiV1ElizaGoogleCalendarCalendars<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/calendar/calendars"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/google/calendar/calendars", TResponse>(
      "GET /api/v1/eliza/google/calendar/calendars",
      options,
    );
  }

  getApiV1ElizaGoogleCalendarFeed<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/calendar/feed"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/google/calendar/feed", TResponse>(
      "GET /api/v1/eliza/google/calendar/feed",
      options,
    );
  }

  getApiV1ElizaGoogleGmailRead<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/gmail/read"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/google/gmail/read", TResponse>(
      "GET /api/v1/eliza/google/gmail/read",
      options,
    );
  }

  getApiV1ElizaGoogleGmailSearch<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/gmail/search"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/google/gmail/search", TResponse>(
      "GET /api/v1/eliza/google/gmail/search",
      options,
    );
  }

  getApiV1ElizaGoogleGmailSubscriptionHeaders<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/gmail/subscription-headers"> = {},
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/google/gmail/subscription-headers",
      TResponse
    >("GET /api/v1/eliza/google/gmail/subscription-headers", options);
  }

  getApiV1ElizaGoogleGmailTriage<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/gmail/triage"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/google/gmail/triage", TResponse>(
      "GET /api/v1/eliza/google/gmail/triage",
      options,
    );
  }

  getApiV1ElizaGoogleStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/google/status", TResponse>(
      "GET /api/v1/eliza/google/status",
      options,
    );
  }

  getApiV1ElizaLaunchSessionsBySessionId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/launch-sessions/{sessionId}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/eliza/launch-sessions/{sessionId}",
      TResponse
    >("GET /api/v1/eliza/launch-sessions/{sessionId}", options);
  }

  getApiV1ElizaLifeopsGithubComplete<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/lifeops/github-complete"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/lifeops/github-complete", TResponse>(
      "GET /api/v1/eliza/lifeops/github-complete",
      options,
    );
  }

  getApiV1ElizaPaypalPopupCallback(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/paypal/popup-callback"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/paypal/popup-callback", options);
  }

  getApiV1ElizaPaypalStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/paypal/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/paypal/status", TResponse>(
      "GET /api/v1/eliza/paypal/status",
      options,
    );
  }

  getApiV1ElizaPersonal<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/personal"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/personal", TResponse>(
      "GET /api/v1/eliza/personal",
      options,
    );
  }

  getApiV1ElizaPlaidStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/plaid/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/eliza/plaid/status", TResponse>(
      "GET /api/v1/eliza/plaid/status",
      options,
    );
  }

  getApiV1Files<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/files"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/files", TResponse>(
      "GET /api/v1/files",
      options,
    );
  }

  getApiV1FilesById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/files/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/files/{id}", TResponse>(
      "GET /api/v1/files/{id}",
      options,
    );
  }

  getApiV1Gallery<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/gallery"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/gallery", TResponse>(
      "GET /api/v1/gallery",
      options,
    );
  }

  getApiV1GalleryExplore<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/gallery/explore"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/gallery/explore", TResponse>(
      "GET /api/v1/gallery/explore",
      options,
    );
  }

  getApiV1GalleryStats<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/gallery/stats"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/gallery/stats", TResponse>(
      "GET /api/v1/gallery/stats",
      options,
    );
  }

  getApiV1HfProxyByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/hf-proxy/{path}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/hf-proxy/{path}", TResponse>(
      "GET /api/v1/hf-proxy/{path}",
      options,
    );
  }

  getApiV1HostedFrontendServeByPath(
    options: PublicRouteCallOptions<"GET /api/v1/hosted-frontend/serve/{[...path]}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/hosted-frontend/serve/{[...path]}",
      options,
    );
  }

  getApiV1JobsByJobId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/jobs/{jobId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/jobs/{jobId}", TResponse>(
      "GET /api/v1/jobs/{jobId}",
      options,
    );
  }

  getApiV1MarketCandlesByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/candles/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/market/candles/{chain}/{address}", TResponse>(
      "GET /api/v1/market/candles/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketPortfolioByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/portfolio/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/market/portfolio/{chain}/{address}",
      TResponse
    >("GET /api/v1/market/portfolio/{chain}/{address}", options);
  }

  getApiV1MarketPreviewPortfolioByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/portfolio/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/market/preview/portfolio/{chain}/{address}",
      TResponse
    >("GET /api/v1/market/preview/portfolio/{chain}/{address}", options);
  }

  getApiV1MarketPreviewPredictions<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/predictions"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/market/preview/predictions", TResponse>(
      "GET /api/v1/market/preview/predictions",
      options,
    );
  }

  getApiV1MarketPreviewPriceByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/price/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/market/preview/price/{chain}/{address}",
      TResponse
    >("GET /api/v1/market/preview/price/{chain}/{address}", options);
  }

  getApiV1MarketPreviewTokenByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/token/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/market/preview/token/{chain}/{address}",
      TResponse
    >("GET /api/v1/market/preview/token/{chain}/{address}", options);
  }

  getApiV1MarketPreviewWalletOverview<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/wallet-overview"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/market/preview/wallet-overview", TResponse>(
      "GET /api/v1/market/preview/wallet-overview",
      options,
    );
  }

  getApiV1MarketPriceByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/price/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/market/price/{chain}/{address}", TResponse>(
      "GET /api/v1/market/price/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketTokenByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/token/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/market/token/{chain}/{address}", TResponse>(
      "GET /api/v1/market/token/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketTradesByChainByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/market/trades/{chain}/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/market/trades/{chain}/{address}", TResponse>(
      "GET /api/v1/market/trades/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketingInfluencers<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/influencers"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/marketing/influencers", TResponse>(
      "GET /api/v1/marketing/influencers",
      options,
    );
  }

  getApiV1MarketingInfluencersBookings<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/influencers/bookings"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/marketing/influencers/bookings", TResponse>(
      "GET /api/v1/marketing/influencers/bookings",
      options,
    );
  }

  getApiV1MarketingInventory<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/inventory"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/marketing/inventory", TResponse>(
      "GET /api/v1/marketing/inventory",
      options,
    );
  }

  getApiV1MarketingInventoryBySlotId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/inventory/{slotId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/marketing/inventory/{slotId}", TResponse>(
      "GET /api/v1/marketing/inventory/{slotId}",
      options,
    );
  }

  getApiV1MarketingInventoryBySlotIdAnalytics<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/inventory/{slotId}/analytics">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/marketing/inventory/{slotId}/analytics",
      TResponse
    >("GET /api/v1/marketing/inventory/{slotId}/analytics", options);
  }

  getApiV1MarketingInventoryServe<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/inventory/serve"> = {},
  ): Promise<CloudResponse<TResponse>> {
    return this.callBodyless<
      "GET /api/v1/marketing/inventory/serve",
      TResponse
    >("GET /api/v1/marketing/inventory/serve", options);
  }

  getApiV1MarketingPr<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/pr"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/marketing/pr", TResponse>(
      "GET /api/v1/marketing/pr",
      options,
    );
  }

  getApiV1MarketingPrByReleaseId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/pr/{releaseId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/marketing/pr/{releaseId}", TResponse>(
      "GET /api/v1/marketing/pr/{releaseId}",
      options,
    );
  }

  getApiV1MarketingPrByReleaseIdCoverage<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/pr/{releaseId}/coverage">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/marketing/pr/{releaseId}/coverage",
      TResponse
    >("GET /api/v1/marketing/pr/{releaseId}/coverage", options);
  }

  getApiV1Mcps<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/mcps"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/mcps", TResponse>(
      "GET /api/v1/mcps",
      options,
    );
  }

  getApiV1McpsByMcpId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/mcps/{mcpId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/mcps/{mcpId}", TResponse>(
      "GET /api/v1/mcps/{mcpId}",
      options,
    );
  }

  getApiV1MeAccountDeletion<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/me/account-deletion"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/me/account-deletion", TResponse>(
      "GET /api/v1/me/account-deletion",
      options,
    );
  }

  getApiV1MeMfa<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/me/mfa"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/me/mfa", TResponse>(
      "GET /api/v1/me/mfa",
      options,
    );
  }

  getApiV1Models<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/models"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/models", TResponse>(
      "GET /api/v1/models",
      options,
    );
  }

  getApiV1ModelsByModel<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/models/{model}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/models/{model}", TResponse>(
      "GET /api/v1/models/{model}",
      options,
    );
  }

  getApiV1ModelsStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/models/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/models/status", TResponse>(
      "GET /api/v1/models/status",
      options,
    );
  }

  getApiV1OauthIntents<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth-intents"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth-intents", TResponse>(
      "GET /api/v1/oauth-intents",
      options,
    );
  }

  getApiV1OauthIntentsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth-intents/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth-intents/{id}", TResponse>(
      "GET /api/v1/oauth-intents/{id}",
      options,
    );
  }

  getApiV1OauthByPlatformCallback<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/{platform}/callback">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/{platform}/callback", TResponse>(
      "GET /api/v1/oauth/{platform}/callback",
      options,
    );
  }

  getApiV1OauthCallback<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/callback"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/callback", TResponse>(
      "GET /api/v1/oauth/callback",
      options,
    );
  }

  getApiV1OauthCallbackByProvider<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/callback/{provider}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/callback/{provider}", TResponse>(
      "GET /api/v1/oauth/callback/{provider}",
      options,
    );
  }

  getApiV1OauthConnections<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/connections"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/connections", TResponse>(
      "GET /api/v1/oauth/connections",
      options,
    );
  }

  getApiV1OauthConnectionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/connections/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/connections/{id}", TResponse>(
      "GET /api/v1/oauth/connections/{id}",
      options,
    );
  }

  getApiV1OauthConnectionsByIdToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/connections/{id}/token">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/connections/{id}/token", TResponse>(
      "GET /api/v1/oauth/connections/{id}/token",
      options,
    );
  }

  getApiV1OauthInitiate<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/initiate"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/initiate", TResponse>(
      "GET /api/v1/oauth/initiate",
      options,
    );
  }

  getApiV1OauthProviders<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/providers"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/providers", TResponse>(
      "GET /api/v1/oauth/providers",
      options,
    );
  }

  getApiV1OauthStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/status", TResponse>(
      "GET /api/v1/oauth/status",
      options,
    );
  }

  getApiV1OauthSuccessProofVerify<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/success-proof/verify"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/success-proof/verify", TResponse>(
      "GET /api/v1/oauth/success-proof/verify",
      options,
    );
  }

  getApiV1OauthTokenByPlatform<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/token/{platform}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/oauth/token/{platform}", TResponse>(
      "GET /api/v1/oauth/token/{platform}",
      options,
    );
  }

  getApiV1Outreachr<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/outreachr"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/outreachr", TResponse>(
      "GET /api/v1/outreachr",
      options,
    );
  }

  getApiV1PaymentRequests<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/payment-requests"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/payment-requests", TResponse>(
      "GET /api/v1/payment-requests",
      options,
    );
  }

  getApiV1PaymentRequestsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/payment-requests/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/payment-requests/{id}", TResponse>(
      "GET /api/v1/payment-requests/{id}",
      options,
    );
  }

  getApiV1PiiScrubJobsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/pii-scrub/jobs/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/pii-scrub/jobs/{id}", TResponse>(
      "GET /api/v1/pii-scrub/jobs/{id}",
      options,
    );
  }

  getApiV1PricingSummary<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/pricing/summary"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/pricing/summary", TResponse>(
      "GET /api/v1/pricing/summary",
      options,
    );
  }

  getApiV1ProxyBirdeyeByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/proxy/birdeye/{path}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/proxy/birdeye/{path}", TResponse>(
      "GET /api/v1/proxy/birdeye/{path}",
      options,
    );
  }

  getApiV1Redemptions<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/redemptions", TResponse>(
      "GET /api/v1/redemptions",
      options,
    );
  }

  getApiV1RedemptionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/redemptions/{id}", TResponse>(
      "GET /api/v1/redemptions/{id}",
      options,
    );
  }

  getApiV1RedemptionsBalance<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions/balance"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/redemptions/balance", TResponse>(
      "GET /api/v1/redemptions/balance",
      options,
    );
  }

  getApiV1RedemptionsQuote<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions/quote"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/redemptions/quote", TResponse>(
      "GET /api/v1/redemptions/quote",
      options,
    );
  }

  getApiV1RedemptionsStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/redemptions/status", TResponse>(
      "GET /api/v1/redemptions/status",
      options,
    );
  }

  getApiV1Referrals<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/referrals"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/referrals", TResponse>(
      "GET /api/v1/referrals",
      options,
    );
  }

  getApiV1RemoteHosts<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/remote/hosts"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/remote/hosts", TResponse>(
      "GET /api/v1/remote/hosts",
      options,
    );
  }

  getApiV1RemoteSessions<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/remote/sessions"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/remote/sessions", TResponse>(
      "GET /api/v1/remote/sessions",
      options,
    );
  }

  getApiV1RemoteSessionsByIdActivate<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/remote/sessions/{id}/activate">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/remote/sessions/{id}/activate", TResponse>(
      "GET /api/v1/remote/sessions/{id}/activate",
      options,
    );
  }

  getApiV1RemoteSessionsByIdCommands<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/remote/sessions/{id}/commands">,
  ): Promise<CloudResponse<TResponse>> {
    return this.callBodyless<
      "GET /api/v1/remote/sessions/{id}/commands",
      TResponse
    >("GET /api/v1/remote/sessions/{id}/commands", options);
  }

  getApiV1RemoteSessionsByIdCommandsByCommandId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/remote/sessions/{id}/commands/{commandId}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/remote/sessions/{id}/commands/{commandId}",
      TResponse
    >("GET /api/v1/remote/sessions/{id}/commands/{commandId}", options);
  }

  getApiV1SensitiveRequestsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/sensitive-requests/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/sensitive-requests/{id}", TResponse>(
      "GET /api/v1/sensitive-requests/{id}",
      options,
    );
  }

  getApiV1Sessions<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/sessions"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/sessions", TResponse>(
      "GET /api/v1/sessions",
      options,
    );
  }

  getApiV1SolanaAssetsByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/solana/assets/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/solana/assets/{address}", TResponse>(
      "GET /api/v1/solana/assets/{address}",
      options,
    );
  }

  getApiV1SolanaMethods<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/solana/methods"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/solana/methods", TResponse>(
      "GET /api/v1/solana/methods",
      options,
    );
  }

  getApiV1SolanaTokenAccountsByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/solana/token-accounts/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/solana/token-accounts/{address}", TResponse>(
      "GET /api/v1/solana/token-accounts/{address}",
      options,
    );
  }

  getApiV1SolanaTransactionsByAddress<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/solana/transactions/{address}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/solana/transactions/{address}", TResponse>(
      "GET /api/v1/solana/transactions/{address}",
      options,
    );
  }

  getApiV1StewardTenantsCredentials<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/steward/tenants/credentials"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/steward/tenants/credentials", TResponse>(
      "GET /api/v1/steward/tenants/credentials",
      options,
    );
  }

  getApiV1SubscriptionsCancelByCommandId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/subscriptions/cancel/{commandId}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/subscriptions/cancel/{commandId}", TResponse>(
      "GET /api/v1/subscriptions/cancel/{commandId}",
      options,
    );
  }

  getApiV1SubscriptionsCancelUndoByCommandId<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/subscriptions/cancel/undo/{commandId}">,
  ): Promise<TResponse> {
    return this.call<
      "GET /api/v1/subscriptions/cancel/undo/{commandId}",
      TResponse
    >("GET /api/v1/subscriptions/cancel/undo/{commandId}", options);
  }

  getApiV1SubscriptionsCommands<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/subscriptions/commands"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/subscriptions/commands", TResponse>(
      "GET /api/v1/subscriptions/commands",
      options,
    );
  }

  getApiV1SubscriptionsPlans<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/subscriptions/plans"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/subscriptions/plans", TResponse>(
      "GET /api/v1/subscriptions/plans",
      options,
    );
  }

  getApiV1TelegramChats<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/telegram/chats"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/telegram/chats", TResponse>(
      "GET /api/v1/telegram/chats",
      options,
    );
  }

  getApiV1TelegramScanChats<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/telegram/scan-chats"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/telegram/scan-chats", TResponse>(
      "GET /api/v1/telegram/scan-chats",
      options,
    );
  }

  getApiV1TelegramStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/telegram/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/telegram/status", TResponse>(
      "GET /api/v1/telegram/status",
      options,
    );
  }

  getApiV1TwilioStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/twilio/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/twilio/status", TResponse>(
      "GET /api/v1/twilio/status",
      options,
    );
  }

  getApiV1TwilioVoiceCallsByCallSid<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/twilio/voice/calls/{callSid}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/twilio/voice/calls/{callSid}", TResponse>(
      "GET /api/v1/twilio/voice/calls/{callSid}",
      options,
    );
  }

  getApiV1TwilioVoiceMedia<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/twilio/voice/media"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/twilio/voice/media", TResponse>(
      "GET /api/v1/twilio/voice/media",
      options,
    );
  }

  getApiV1TwitterCallback<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/twitter/callback"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/twitter/callback", TResponse>(
      "GET /api/v1/twitter/callback",
      options,
    );
  }

  getApiV1TwitterStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/twitter/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/twitter/status", TResponse>(
      "GET /api/v1/twitter/status",
      options,
    );
  }

  getApiV1TwitterToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/twitter/token"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/twitter/token", TResponse>(
      "GET /api/v1/twitter/token",
      options,
    );
  }

  getApiV1User<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/user"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/user", TResponse>(
      "GET /api/v1/user",
      options,
    );
  }

  getApiV1UserWallets<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/user/wallets"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/user/wallets", TResponse>(
      "GET /api/v1/user/wallets",
      options,
    );
  }

  getApiV1VideoFeatured<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/video/featured"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/video/featured", TResponse>(
      "GET /api/v1/video/featured",
      options,
    );
  }

  getApiV1VideoUsage<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/video/usage"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/video/usage", TResponse>(
      "GET /api/v1/video/usage",
      options,
    );
  }

  getApiV1VoiceModelsCatalog<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/voice-models/catalog"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/voice-models/catalog", TResponse>(
      "GET /api/v1/voice-models/catalog",
      options,
    );
  }

  getApiV1VoiceById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/voice/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/voice/{id}", TResponse>(
      "GET /api/v1/voice/{id}",
      options,
    );
  }

  getApiV1VoiceJobs<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/voice/jobs"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/voice/jobs", TResponse>(
      "GET /api/v1/voice/jobs",
      options,
    );
  }

  getApiV1VoiceList<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/voice/list"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/voice/list", TResponse>(
      "GET /api/v1/voice/list",
      options,
    );
  }

  getApiV1VoiceSessionWs<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/voice/session/ws"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/voice/session/ws", TResponse>(
      "GET /api/v1/voice/session/ws",
      options,
    );
  }

  getApiV1WhatsappStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/whatsapp/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/whatsapp/status", TResponse>(
      "GET /api/v1/whatsapp/status",
      options,
    );
  }

  getApiV1XDmsDigest<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/x/dms/digest"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/x/dms/digest", TResponse>(
      "GET /api/v1/x/dms/digest",
      options,
    );
  }

  getApiV1XFeed<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/x/feed"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/x/feed", TResponse>(
      "GET /api/v1/x/feed",
      options,
    );
  }

  getApiV1XStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/x/status"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/x/status", TResponse>(
      "GET /api/v1/x/status",
      options,
    );
  }

  getApiV1X402<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/x402"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/x402", TResponse>(
      "GET /api/v1/x402",
      options,
    );
  }

  getApiV1X402Requests<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/x402/requests"> = {},
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/x402/requests", TResponse>(
      "GET /api/v1/x402/requests",
      options,
    );
  }

  getApiV1X402RequestsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"GET /api/v1/x402/requests/{id}">,
  ): Promise<TResponse> {
    return this.call<"GET /api/v1/x402/requests/{id}", TResponse>(
      "GET /api/v1/x402/requests/{id}",
      options,
    );
  }

  headApiV1ApisStorageObjects(
    options: PublicRouteCallOptions<"HEAD /api/v1/apis/storage/objects/_">,
  ): Promise<Response> {
    return this.callRaw("HEAD /api/v1/apis/storage/objects/_", options);
  }

  patchApiElevenlabsVoicesById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/elevenlabs/voices/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/elevenlabs/voices/{id}", TResponse>(
      "PATCH /api/elevenlabs/voices/{id}",
      options,
    );
  }

  patchApiV1AdvertisingAccountsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/advertising/accounts/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/advertising/accounts/{id}", TResponse>(
      "PATCH /api/v1/advertising/accounts/{id}",
      options,
    );
  }

  patchApiV1AdvertisingAudienceSegmentsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/advertising/audience-segments/{id}">,
  ): Promise<TResponse> {
    return this.call<
      "PATCH /api/v1/advertising/audience-segments/{id}",
      TResponse
    >("PATCH /api/v1/advertising/audience-segments/{id}", options);
  }

  patchApiV1AdvertisingCampaignsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/advertising/campaigns/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/advertising/campaigns/{id}", TResponse>(
      "PATCH /api/v1/advertising/campaigns/{id}",
      options,
    );
  }

  patchApiV1AdvertisingCreativesById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/advertising/creatives/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/advertising/creatives/{id}", TResponse>(
      "PATCH /api/v1/advertising/creatives/{id}",
      options,
    );
  }

  patchApiV1ApiKeysById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/api-keys/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/api-keys/{id}", TResponse>(
      "PATCH /api/v1/api-keys/{id}",
      options,
    );
  }

  patchApiV1AppsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/apps/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/apps/{id}", TResponse>(
      "PATCH /api/v1/apps/{id}",
      options,
    );
  }

  patchApiV1AppsByIdDomainsByDomainDnsByRecordId<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/apps/{id}/domains/{domain}/dns/{recordId}">,
  ): Promise<TResponse> {
    return this.call<
      "PATCH /api/v1/apps/{id}/domains/{domain}/dns/{recordId}",
      TResponse
    >("PATCH /api/v1/apps/{id}/domains/{domain}/dns/{recordId}", options);
  }

  patchApiV1ConnectionsByPlatform<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/connections/{platform}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/connections/{platform}", TResponse>(
      "PATCH /api/v1/connections/{platform}",
      options,
    );
  }

  patchApiV1ContainersById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/containers/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/containers/{id}", TResponse>(
      "PATCH /api/v1/containers/{id}",
      options,
    );
  }

  patchApiV1DiscordConnectionsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/discord/connections/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/discord/connections/{id}", TResponse>(
      "PATCH /api/v1/discord/connections/{id}",
      options,
    );
  }

  patchApiV1ElizaAgentsByAgentId<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/agents/{agentId}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/eliza/agents/{agentId}", TResponse>(
      "PATCH /api/v1/eliza/agents/{agentId}",
      options,
    );
  }

  patchApiV1ElizaAgentsByAgentIdApiByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<TResponse> {
    return this.call<
      "PATCH /api/v1/eliza/agents/{agentId}/api/{path}",
      TResponse
    >("PATCH /api/v1/eliza/agents/{agentId}/api/{path}", options);
  }

  patchApiV1ElizaAgentsByAgentIdApiConversationsByConversationId<
    TResponse = unknown,
  >(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}">,
  ): Promise<TResponse> {
    return this.call<
      "PATCH /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}",
      TResponse
    >(
      "PATCH /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}",
      options,
    );
  }

  patchApiV1ElizaAgentsByAgentIdEnvironment<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/agents/{agentId}/environment">,
  ): Promise<TResponse> {
    return this.call<
      "PATCH /api/v1/eliza/agents/{agentId}/environment",
      TResponse
    >("PATCH /api/v1/eliza/agents/{agentId}/environment", options);
  }

  patchApiV1ElizaGoogleCalendarEventsByEventId<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/google/calendar/events/{eventId}">,
  ): Promise<TResponse> {
    return this.call<
      "PATCH /api/v1/eliza/google/calendar/events/{eventId}",
      TResponse
    >("PATCH /api/v1/eliza/google/calendar/events/{eventId}", options);
  }

  patchApiV1MarketingInventoryBySlotId<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/marketing/inventory/{slotId}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/marketing/inventory/{slotId}", TResponse>(
      "PATCH /api/v1/marketing/inventory/{slotId}",
      options,
    );
  }

  patchApiV1MarketingPrByReleaseId<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/marketing/pr/{releaseId}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/marketing/pr/{releaseId}", TResponse>(
      "PATCH /api/v1/marketing/pr/{releaseId}",
      options,
    );
  }

  patchApiV1ProxyBirdeyeByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/proxy/birdeye/{path}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/proxy/birdeye/{path}", TResponse>(
      "PATCH /api/v1/proxy/birdeye/{path}",
      options,
    );
  }

  patchApiV1RemoteSessionsByIdActivate<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/remote/sessions/{id}/activate">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/remote/sessions/{id}/activate", TResponse>(
      "PATCH /api/v1/remote/sessions/{id}/activate",
      options,
    );
  }

  patchApiV1User<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/user"> = {},
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/user", TResponse>(
      "PATCH /api/v1/user",
      options,
    );
  }

  patchApiV1UserEmail<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/user/email"> = {},
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/user/email", TResponse>(
      "PATCH /api/v1/user/email",
      options,
    );
  }

  patchApiV1VoiceById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PATCH /api/v1/voice/{id}">,
  ): Promise<TResponse> {
    return this.call<"PATCH /api/v1/voice/{id}", TResponse>(
      "PATCH /api/v1/voice/{id}",
      options,
    );
  }

  postApiElevenlabsStt<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/elevenlabs/stt"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/elevenlabs/stt", TResponse>(
      "POST /api/elevenlabs/stt",
      options,
    );
  }

  postApiElevenlabsTts(
    options: PublicRouteCallOptions<"POST /api/elevenlabs/tts"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/elevenlabs/tts", options);
  }

  postApiV1AdvertisingAccounts<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/accounts"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/advertising/accounts", TResponse>(
      "POST /api/v1/advertising/accounts",
      options,
    );
  }

  postApiV1AdvertisingAccountsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/accounts/{id}">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/advertising/accounts/{id}", TResponse>(
      "POST /api/v1/advertising/accounts/{id}",
      options,
    );
  }

  postApiV1AdvertisingAccountsByIdMedia<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/accounts/{id}/media">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/advertising/accounts/{id}/media", TResponse>(
      "POST /api/v1/advertising/accounts/{id}/media",
      options,
    );
  }

  postApiV1AdvertisingAccountsDiscover<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/accounts/discover"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/advertising/accounts/discover", TResponse>(
      "POST /api/v1/advertising/accounts/discover",
      options,
    );
  }

  postApiV1AdvertisingAudienceSegments<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/audience-segments"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/advertising/audience-segments", TResponse>(
      "POST /api/v1/advertising/audience-segments",
      options,
    );
  }

  postApiV1AdvertisingAudienceSegmentsByIdApply<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/audience-segments/{id}/apply">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/advertising/audience-segments/{id}/apply",
      TResponse
    >("POST /api/v1/advertising/audience-segments/{id}/apply", options);
  }

  postApiV1AdvertisingCampaigns<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/advertising/campaigns", TResponse>(
      "POST /api/v1/advertising/campaigns",
      options,
    );
  }

  postApiV1AdvertisingCampaignsByIdAttribution<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/attribution">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/advertising/campaigns/{id}/attribution",
      TResponse
    >("POST /api/v1/advertising/campaigns/{id}/attribution", options);
  }

  postApiV1AdvertisingCampaignsByIdCreatives<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/creatives">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/advertising/campaigns/{id}/creatives",
      TResponse
    >("POST /api/v1/advertising/campaigns/{id}/creatives", options);
  }

  postApiV1AdvertisingCampaignsByIdDuplicate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/duplicate">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/advertising/campaigns/{id}/duplicate",
      TResponse
    >("POST /api/v1/advertising/campaigns/{id}/duplicate", options);
  }

  postApiV1AdvertisingCampaignsByIdPause<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/pause">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/advertising/campaigns/{id}/pause",
      TResponse
    >("POST /api/v1/advertising/campaigns/{id}/pause", options);
  }

  postApiV1AdvertisingCampaignsByIdReportShare<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/report/share">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/advertising/campaigns/{id}/report/share",
      TResponse
    >("POST /api/v1/advertising/campaigns/{id}/report/share", options);
  }

  postApiV1AdvertisingCampaignsByIdStart<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/start">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/advertising/campaigns/{id}/start",
      TResponse
    >("POST /api/v1/advertising/campaigns/{id}/start", options);
  }

  postApiV1AdvertisingConversionsTrack<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/conversions/track"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/advertising/conversions/track", TResponse>(
      "POST /api/v1/advertising/conversions/track",
      options,
    );
  }

  postApiV1Affiliates<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/affiliates"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/affiliates", TResponse>(
      "POST /api/v1/affiliates",
      options,
    );
  }

  postApiV1AffiliatesLink<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/affiliates/link"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/affiliates/link", TResponse>(
      "POST /api/v1/affiliates/link",
      options,
    );
  }

  postApiV1AgentTokens<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agent-tokens"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/agent-tokens", TResponse>(
      "POST /api/v1/agent-tokens",
      options,
    );
  }

  postApiV1Agents<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agents"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/agents", TResponse>(
      "POST /api/v1/agents",
      options,
    );
  }

  postApiV1AgentsByAgentIdMessage<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/message">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/agents/{agentId}/message", TResponse>(
      "POST /api/v1/agents/{agentId}/message",
      options,
    );
  }

  postApiV1AgentsByAgentIdPublish<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/publish">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/agents/{agentId}/publish", TResponse>(
      "POST /api/v1/agents/{agentId}/publish",
      options,
    );
  }

  postApiV1AgentsByAgentIdRestart<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/restart">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/agents/{agentId}/restart", TResponse>(
      "POST /api/v1/agents/{agentId}/restart",
      options,
    );
  }

  postApiV1AgentsByAgentIdResume<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/resume">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/agents/{agentId}/resume", TResponse>(
      "POST /api/v1/agents/{agentId}/resume",
      options,
    );
  }

  postApiV1AgentsByAgentIdSuspend<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/suspend">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/agents/{agentId}/suspend", TResponse>(
      "POST /api/v1/agents/{agentId}/suspend",
      options,
    );
  }

  postApiV1AgentsByAgentIdWorkflows<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/workflows">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/agents/{agentId}/workflows", TResponse>(
      "POST /api/v1/agents/{agentId}/workflows",
      options,
    );
  }

  postApiV1AgentsByAgentIdWorkflowsByWorkflowIdRun<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/workflows/{workflowId}/run">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/agents/{agentId}/workflows/{workflowId}/run",
      TResponse
    >("POST /api/v1/agents/{agentId}/workflows/{workflowId}/run", options);
  }

  postApiV1ApiKeys<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/api-keys"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/api-keys", TResponse>(
      "POST /api/v1/api-keys",
      options,
    );
  }

  postApiV1ApiKeysByIdRegenerate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/api-keys/{id}/regenerate">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/api-keys/{id}/regenerate", TResponse>(
      "POST /api/v1/api-keys/{id}/regenerate",
      options,
    );
  }

  postApiV1ApisStoragePresign<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apis/storage/presign">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apis/storage/presign", TResponse>(
      "POST /api/v1/apis/storage/presign",
      options,
    );
  }

  postApiV1ApisTunnelsTailscaleAuthKey<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apis/tunnels/tailscale/auth-key"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apis/tunnels/tailscale/auth-key", TResponse>(
      "POST /api/v1/apis/tunnels/tailscale/auth-key",
      options,
    );
  }

  postApiV1AppAuthConnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/app-auth/connect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/app-auth/connect", TResponse>(
      "POST /api/v1/app-auth/connect",
      options,
    );
  }

  postApiV1AppAuthMobileAck<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/app-auth/mobile/ack"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/app-auth/mobile/ack", TResponse>(
      "POST /api/v1/app-auth/mobile/ack",
      options,
    );
  }

  postApiV1AppAuthMobileToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/app-auth/mobile/token"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/app-auth/mobile/token", TResponse>(
      "POST /api/v1/app-auth/mobile/token",
      options,
    );
  }

  postApiV1AppCreditsCheckout<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/app-credits/checkout"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/app-credits/checkout", TResponse>(
      "POST /api/v1/app-credits/checkout",
      options,
    );
  }

  postApiV1AppAgents<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/app/agents"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/app/agents", TResponse>(
      "POST /api/v1/app/agents",
      options,
    );
  }

  postApiV1ApprovalRequests<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/approval-requests"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/approval-requests", TResponse>(
      "POST /api/v1/approval-requests",
      options,
    );
  }

  postApiV1ApprovalRequestsByIdApprove<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/approval-requests/{id}/approve">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/approval-requests/{id}/approve", TResponse>(
      "POST /api/v1/approval-requests/{id}/approve",
      options,
    );
  }

  postApiV1ApprovalRequestsByIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/approval-requests/{id}/cancel">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/approval-requests/{id}/cancel", TResponse>(
      "POST /api/v1/approval-requests/{id}/cancel",
      options,
    );
  }

  postApiV1ApprovalRequestsByIdDeny<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/approval-requests/{id}/deny">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/approval-requests/{id}/deny", TResponse>(
      "POST /api/v1/approval-requests/{id}/deny",
      options,
    );
  }

  postApiV1Apps<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps", TResponse>(
      "POST /api/v1/apps",
      options,
    );
  }

  postApiV1AppsByIdBillingRegistration<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/billing/registration">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/billing/registration", TResponse>(
      "POST /api/v1/apps/{id}/billing/registration",
      options,
    );
  }

  postApiV1AppsByIdCharges<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/charges">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/charges", TResponse>(
      "POST /api/v1/apps/{id}/charges",
      options,
    );
  }

  postApiV1AppsByIdChargesByChargeIdCheckout<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/charges/{chargeId}/checkout">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/apps/{id}/charges/{chargeId}/checkout",
      TResponse
    >("POST /api/v1/apps/{id}/charges/{chargeId}/checkout", options);
  }

  postApiV1AppsByIdChat<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/chat">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/chat", TResponse>(
      "POST /api/v1/apps/{id}/chat",
      options,
    );
  }

  postApiV1AppsByIdDeploy<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/deploy">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/deploy", TResponse>(
      "POST /api/v1/apps/{id}/deploy",
      options,
    );
  }

  postApiV1AppsByIdDiscordAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/discord-automation">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/discord-automation", TResponse>(
      "POST /api/v1/apps/{id}/discord-automation",
      options,
    );
  }

  postApiV1AppsByIdDiscordAutomationPost<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/discord-automation/post">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/apps/{id}/discord-automation/post",
      TResponse
    >("POST /api/v1/apps/{id}/discord-automation/post", options);
  }

  postApiV1AppsByIdDomains<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/domains", TResponse>(
      "POST /api/v1/apps/{id}/domains",
      options,
    );
  }

  postApiV1AppsByIdDomainsByDomainDns<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/{domain}/dns">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/domains/{domain}/dns", TResponse>(
      "POST /api/v1/apps/{id}/domains/{domain}/dns",
      options,
    );
  }

  postApiV1AppsByIdDomainsBuy<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/buy">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/domains/buy", TResponse>(
      "POST /api/v1/apps/{id}/domains/buy",
      options,
    );
  }

  postApiV1AppsByIdDomainsCheck<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/check">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/domains/check", TResponse>(
      "POST /api/v1/apps/{id}/domains/check",
      options,
    );
  }

  postApiV1AppsByIdDomainsStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/status">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/domains/status", TResponse>(
      "POST /api/v1/apps/{id}/domains/status",
      options,
    );
  }

  postApiV1AppsByIdDomainsSync<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/sync">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/domains/sync", TResponse>(
      "POST /api/v1/apps/{id}/domains/sync",
      options,
    );
  }

  postApiV1AppsByIdDomainsVerify<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/verify">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/domains/verify", TResponse>(
      "POST /api/v1/apps/{id}/domains/verify",
      options,
    );
  }

  postApiV1AppsByIdEarningsWithdraw<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/earnings/withdraw">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/earnings/withdraw", TResponse>(
      "POST /api/v1/apps/{id}/earnings/withdraw",
      options,
    );
  }

  postApiV1AppsByIdFrontend<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/frontend">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/frontend", TResponse>(
      "POST /api/v1/apps/{id}/frontend",
      options,
    );
  }

  postApiV1AppsByIdFrontendByDeploymentIdActivate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/frontend/{deploymentId}/activate">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/apps/{id}/frontend/{deploymentId}/activate",
      TResponse
    >("POST /api/v1/apps/{id}/frontend/{deploymentId}/activate", options);
  }

  postApiV1AppsByIdGenerateImage<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/generate-image">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/generate-image", TResponse>(
      "POST /api/v1/apps/{id}/generate-image",
      options,
    );
  }

  postApiV1AppsByIdPromote<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/promote">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/promote", TResponse>(
      "POST /api/v1/apps/{id}/promote",
      options,
    );
  }

  postApiV1AppsByIdPromoteAssets<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/promote/assets">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/promote/assets", TResponse>(
      "POST /api/v1/apps/{id}/promote/assets",
      options,
    );
  }

  postApiV1AppsByIdPromotePreview<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/promote/preview">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/promote/preview", TResponse>(
      "POST /api/v1/apps/{id}/promote/preview",
      options,
    );
  }

  postApiV1AppsByIdRegenerateApiKey<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/regenerate-api-key">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/regenerate-api-key", TResponse>(
      "POST /api/v1/apps/{id}/regenerate-api-key",
      options,
    );
  }

  postApiV1AppsByIdReview<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/review">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/review", TResponse>(
      "POST /api/v1/apps/{id}/review",
      options,
    );
  }

  postApiV1AppsByIdTelegramAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/telegram-automation">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/telegram-automation", TResponse>(
      "POST /api/v1/apps/{id}/telegram-automation",
      options,
    );
  }

  postApiV1AppsByIdTelegramAutomationPost<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/telegram-automation/post">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/apps/{id}/telegram-automation/post",
      TResponse
    >("POST /api/v1/apps/{id}/telegram-automation/post", options);
  }

  postApiV1AppsByIdTwitterAutomation<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/twitter-automation">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/{id}/twitter-automation", TResponse>(
      "POST /api/v1/apps/{id}/twitter-automation",
      options,
    );
  }

  postApiV1AppsByIdTwitterAutomationPost<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/twitter-automation/post">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/apps/{id}/twitter-automation/post",
      TResponse
    >("POST /api/v1/apps/{id}/twitter-automation/post", options);
  }

  postApiV1AppsBackupRestore<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/backup/restore"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/backup/restore", TResponse>(
      "POST /api/v1/apps/backup/restore",
      options,
    );
  }

  postApiV1AppsCheckName<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/apps/check-name"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/apps/check-name", TResponse>(
      "POST /api/v1/apps/check-name",
      options,
    );
  }

  postApiV1Ballots<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/ballots"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/ballots", TResponse>(
      "POST /api/v1/ballots",
      options,
    );
  }

  postApiV1BallotsByIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/ballots/{id}/cancel">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/ballots/{id}/cancel", TResponse>(
      "POST /api/v1/ballots/{id}/cancel",
      options,
    );
  }

  postApiV1BallotsByIdDistribute<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/ballots/{id}/distribute">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/ballots/{id}/distribute", TResponse>(
      "POST /api/v1/ballots/{id}/distribute",
      options,
    );
  }

  postApiV1BallotsByIdTally<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/ballots/{id}/tally">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/ballots/{id}/tally", TResponse>(
      "POST /api/v1/ballots/{id}/tally",
      options,
    );
  }

  postApiV1BallotsByIdVote<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/ballots/{id}/vote">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/ballots/{id}/vote", TResponse>(
      "POST /api/v1/ballots/{id}/vote",
      options,
    );
  }

  postApiV1BillingResourcesByIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/billing/resources/{id}/cancel">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/billing/resources/{id}/cancel", TResponse>(
      "POST /api/v1/billing/resources/{id}/cancel",
      options,
    );
  }

  postApiV1BlooioConnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/blooio/connect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/blooio/connect", TResponse>(
      "POST /api/v1/blooio/connect",
      options,
    );
  }

  postApiV1BlooioDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/blooio/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/blooio/disconnect", TResponse>(
      "POST /api/v1/blooio/disconnect",
      options,
    );
  }

  postApiV1BrowserSessions<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/browser/sessions"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/browser/sessions", TResponse>(
      "POST /api/v1/browser/sessions",
      options,
    );
  }

  postApiV1BrowserSessionsByIdCommand<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/browser/sessions/{id}/command">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/browser/sessions/{id}/command", TResponse>(
      "POST /api/v1/browser/sessions/{id}/command",
      options,
    );
  }

  postApiV1BrowserSessionsByIdNavigate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/browser/sessions/{id}/navigate">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/browser/sessions/{id}/navigate", TResponse>(
      "POST /api/v1/browser/sessions/{id}/navigate",
      options,
    );
  }

  postApiV1Chat<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/chat"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/chat", TResponse>(
      "POST /api/v1/chat",
      options,
    );
  }

  postApiV1ChatCompletions<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/chat/completions"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/chat/completions", TResponse>(
      "POST /api/v1/chat/completions",
      options,
    );
  }

  postApiV1CodingContainers<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/coding-containers"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/coding-containers", TResponse>(
      "POST /api/v1/coding-containers",
      options,
    );
  }

  postApiV1CodingContainersByContainerIdSync<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/coding-containers/{containerId}/sync">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/coding-containers/{containerId}/sync",
      TResponse
    >("POST /api/v1/coding-containers/{containerId}/sync", options);
  }

  postApiV1CodingContainersPromotions<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/coding-containers/promotions"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/coding-containers/promotions", TResponse>(
      "POST /api/v1/coding-containers/promotions",
      options,
    );
  }

  postApiV1ConnectionsByIdBroker<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/connections/{id}/broker">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/connections/{id}/broker", TResponse>(
      "POST /api/v1/connections/{id}/broker",
      options,
    );
  }

  postApiV1ConnectionsByIdRefresh<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/connections/{id}/refresh">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/connections/{id}/refresh", TResponse>(
      "POST /api/v1/connections/{id}/refresh",
      options,
    );
  }

  postApiV1ConnectionsByPlatform<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/connections/{platform}">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/connections/{platform}", TResponse>(
      "POST /api/v1/connections/{platform}",
      options,
    );
  }

  postApiV1Containers<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/containers"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/containers", TResponse>(
      "POST /api/v1/containers",
      options,
    );
  }

  postApiV1CreditsCheckout<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/credits/checkout"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/credits/checkout", TResponse>(
      "POST /api/v1/credits/checkout",
      options,
    );
  }

  postApiV1DeviceBusDevices<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/device-bus/devices"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/device-bus/devices", TResponse>(
      "POST /api/v1/device-bus/devices",
      options,
    );
  }

  postApiV1DeviceBusIntents<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/device-bus/intents"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/device-bus/intents", TResponse>(
      "POST /api/v1/device-bus/intents",
      options,
    );
  }

  postApiV1DiscordChannelsRefresh<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/discord/channels/refresh"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/discord/channels/refresh", TResponse>(
      "POST /api/v1/discord/channels/refresh",
      options,
    );
  }

  postApiV1DiscordConnections<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/discord/connections"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/discord/connections", TResponse>(
      "POST /api/v1/discord/connections",
      options,
    );
  }

  postApiV1DiscordDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/discord/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/discord/disconnect", TResponse>(
      "POST /api/v1/discord/disconnect",
      options,
    );
  }

  postApiV1Documents<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/documents"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/documents", TResponse>(
      "POST /api/v1/documents",
      options,
    );
  }

  postApiV1DocumentsPreUpload<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/documents/pre-upload"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/documents/pre-upload", TResponse>(
      "POST /api/v1/documents/pre-upload",
      options,
    );
  }

  postApiV1DocumentsQuery<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/documents/query"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/documents/query", TResponse>(
      "POST /api/v1/documents/query",
      options,
    );
  }

  postApiV1DocumentsSubmit<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/documents/submit"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/documents/submit", TResponse>(
      "POST /api/v1/documents/submit",
      options,
    );
  }

  postApiV1DocumentsUploadFile<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/documents/upload-file"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/documents/upload-file", TResponse>(
      "POST /api/v1/documents/upload-file",
      options,
    );
  }

  postApiV1DomainsSearch<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/domains/search"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/domains/search", TResponse>(
      "POST /api/v1/domains/search",
      options,
    );
  }

  postApiV1EarningsPayoutStripeConnectOnboard<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/earnings/payout/stripe-connect/onboard"> = {},
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/earnings/payout/stripe-connect/onboard",
      TResponse
    >("POST /api/v1/earnings/payout/stripe-connect/onboard", options);
  }

  postApiV1EarningsPayoutStripeConnectTransfer<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/earnings/payout/stripe-connect/transfer"> = {},
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/earnings/payout/stripe-connect/transfer",
      TResponse
    >("POST /api/v1/earnings/payout/stripe-connect/transfer", options);
  }

  postApiV1ElizaAgents<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents", TResponse>(
      "POST /api/v1/eliza/agents",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdApiByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/api/{path}",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/api/{path}", options);
  }

  postApiV1ElizaAgentsByAgentIdApiConversations<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/conversations">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/api/conversations",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/api/conversations", options);
  }

  postApiV1ElizaAgentsByAgentIdApiConversationsByConversationIdMessages<
    TResponse = unknown,
  >(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages",
      TResponse
    >(
      "POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdApiConversationsByConversationIdMessagesStream(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages/stream">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages/stream",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdApiIdentityRegister<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/identity/register">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/api/identity/register",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/api/identity/register", options);
  }

  postApiV1ElizaAgentsByAgentIdApiWalletByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/wallet/{path}">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/api/wallet/{path}",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/api/wallet/{path}", options);
  }

  postApiV1ElizaAgentsByAgentIdBridge<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/bridge">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents/{agentId}/bridge", TResponse>(
      "POST /api/v1/eliza/agents/{agentId}/bridge",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdDiscordOauth<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/discord/oauth">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/discord/oauth",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/discord/oauth", options);
  }

  postApiV1ElizaAgentsByAgentIdDowngrade<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/downgrade">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/downgrade",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/downgrade", options);
  }

  postApiV1ElizaAgentsByAgentIdGithubDeviceCode<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/github/device-code">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/github/device-code",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/github/device-code", options);
  }

  postApiV1ElizaAgentsByAgentIdGithubLink<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/github/link">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/github/link",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/github/link", options);
  }

  postApiV1ElizaAgentsByAgentIdGithubOauth<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/github/oauth">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/github/oauth",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/github/oauth", options);
  }

  postApiV1ElizaAgentsByAgentIdLifeopsScheduleObservations<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/lifeops/schedule/observations">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/lifeops/schedule/observations",
      TResponse
    >(
      "POST /api/v1/eliza/agents/{agentId}/lifeops/schedule/observations",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdPairingToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/pairing-token">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/pairing-token",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/pairing-token", options);
  }

  postApiV1ElizaAgentsByAgentIdProvision<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/provision">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/provision",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/provision", options);
  }

  postApiV1ElizaAgentsByAgentIdRestore<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/restore">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents/{agentId}/restore", TResponse>(
      "POST /api/v1/eliza/agents/{agentId}/restore",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdResume<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/resume">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents/{agentId}/resume", TResponse>(
      "POST /api/v1/eliza/agents/{agentId}/resume",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdSharedRemindersByTaskIdDeliver<
    TResponse = unknown,
  >(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/shared-reminders/{taskId}/deliver">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/shared-reminders/{taskId}/deliver",
      TResponse
    >(
      "POST /api/v1/eliza/agents/{agentId}/shared-reminders/{taskId}/deliver",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdSleep<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/sleep">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents/{agentId}/sleep", TResponse>(
      "POST /api/v1/eliza/agents/{agentId}/sleep",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdSnapshot<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/snapshot">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents/{agentId}/snapshot", TResponse>(
      "POST /api/v1/eliza/agents/{agentId}/snapshot",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdStream(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/stream">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/stream", options);
  }

  postApiV1ElizaAgentsByAgentIdSuspend<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/suspend">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents/{agentId}/suspend", TResponse>(
      "POST /api/v1/eliza/agents/{agentId}/suspend",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdUpgradeTier<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/upgrade-tier">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/upgrade-tier",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/upgrade-tier", options);
  }

  postApiV1ElizaAgentsByAgentIdUpgradeTierAdoptExisting<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing",
      TResponse
    >(
      "POST /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdUpgradeTierCutover<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/upgrade-tier/cutover">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/agents/{agentId}/upgrade-tier/cutover",
      TResponse
    >("POST /api/v1/eliza/agents/{agentId}/upgrade-tier/cutover", options);
  }

  postApiV1ElizaAgentsByAgentIdWake<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/wake">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents/{agentId}/wake", TResponse>(
      "POST /api/v1/eliza/agents/{agentId}/wake",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdWrite<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/write">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/agents/{agentId}/write", TResponse>(
      "POST /api/v1/eliza/agents/{agentId}/write",
      options,
    );
  }

  postApiV1ElizaDiscordGatewayAgent<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/discord/gateway-agent"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/discord/gateway-agent", TResponse>(
      "POST /api/v1/eliza/discord/gateway-agent",
      options,
    );
  }

  postApiV1ElizaGatewayRelaySessions<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/gateway-relay/sessions"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/gateway-relay/sessions", TResponse>(
      "POST /api/v1/eliza/gateway-relay/sessions",
      options,
    );
  }

  postApiV1ElizaGatewayRelaySessionsBySessionIdResponses<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/gateway-relay/sessions/{sessionId}/responses">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/eliza/gateway-relay/sessions/{sessionId}/responses",
      TResponse
    >(
      "POST /api/v1/eliza/gateway-relay/sessions/{sessionId}/responses",
      options,
    );
  }

  postApiV1ElizaGoogleCalendarEvents<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/calendar/events"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/google/calendar/events", TResponse>(
      "POST /api/v1/eliza/google/calendar/events",
      options,
    );
  }

  postApiV1ElizaGoogleConnectInitiate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/connect/initiate"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/google/connect/initiate", TResponse>(
      "POST /api/v1/eliza/google/connect/initiate",
      options,
    );
  }

  postApiV1ElizaGoogleDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/google/disconnect", TResponse>(
      "POST /api/v1/eliza/google/disconnect",
      options,
    );
  }

  postApiV1ElizaGoogleGmailMessageSend<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/gmail/message-send"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/google/gmail/message-send", TResponse>(
      "POST /api/v1/eliza/google/gmail/message-send",
      options,
    );
  }

  postApiV1ElizaGoogleGmailReplySend<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/gmail/reply-send"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/google/gmail/reply-send", TResponse>(
      "POST /api/v1/eliza/google/gmail/reply-send",
      options,
    );
  }

  postApiV1ElizaPaypalAuthorize<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/paypal/authorize"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/paypal/authorize", TResponse>(
      "POST /api/v1/eliza/paypal/authorize",
      options,
    );
  }

  postApiV1ElizaPaypalCallback<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/paypal/callback"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/paypal/callback", TResponse>(
      "POST /api/v1/eliza/paypal/callback",
      options,
    );
  }

  postApiV1ElizaPaypalRefresh<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/paypal/refresh"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/paypal/refresh", TResponse>(
      "POST /api/v1/eliza/paypal/refresh",
      options,
    );
  }

  postApiV1ElizaPaypalTransactions<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/paypal/transactions"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/paypal/transactions", TResponse>(
      "POST /api/v1/eliza/paypal/transactions",
      options,
    );
  }

  postApiV1ElizaPlaidExchange<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/exchange"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/plaid/exchange", TResponse>(
      "POST /api/v1/eliza/plaid/exchange",
      options,
    );
  }

  postApiV1ElizaPlaidItemConnection<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/item-connection"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/plaid/item-connection", TResponse>(
      "POST /api/v1/eliza/plaid/item-connection",
      options,
    );
  }

  postApiV1ElizaPlaidItemStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/item-status"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/plaid/item-status", TResponse>(
      "POST /api/v1/eliza/plaid/item-status",
      options,
    );
  }

  postApiV1ElizaPlaidLinkToken<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/link-token"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/plaid/link-token", TResponse>(
      "POST /api/v1/eliza/plaid/link-token",
      options,
    );
  }

  postApiV1ElizaPlaidRevoke<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/revoke"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/plaid/revoke", TResponse>(
      "POST /api/v1/eliza/plaid/revoke",
      options,
    );
  }

  postApiV1ElizaPlaidSync<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/sync"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/plaid/sync", TResponse>(
      "POST /api/v1/eliza/plaid/sync",
      options,
    );
  }

  postApiV1ElizaPlaidVerificationKey<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/verification-key"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/eliza/plaid/verification-key", TResponse>(
      "POST /api/v1/eliza/plaid/verification-key",
      options,
    );
  }

  postApiV1Embeddings<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/embeddings"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/embeddings", TResponse>(
      "POST /api/v1/embeddings",
      options,
    );
  }

  postApiV1Extract<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/extract"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/extract", TResponse>(
      "POST /api/v1/extract",
      options,
    );
  }

  postApiV1Files<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/files"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/files", TResponse>(
      "POST /api/v1/files",
      options,
    );
  }

  postApiV1GenerateImage<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/generate-image"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/generate-image", TResponse>(
      "POST /api/v1/generate-image",
      options,
    );
  }

  postApiV1GenerateMusic<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/generate-music"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/generate-music", TResponse>(
      "POST /api/v1/generate-music",
      options,
    );
  }

  postApiV1GeneratePrompts<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/generate-prompts"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/generate-prompts", TResponse>(
      "POST /api/v1/generate-prompts",
      options,
    );
  }

  postApiV1GenerateSfx<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/generate-sfx"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/generate-sfx", TResponse>(
      "POST /api/v1/generate-sfx",
      options,
    );
  }

  postApiV1GenerateVideo<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/generate-video"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/generate-video", TResponse>(
      "POST /api/v1/generate-video",
      options,
    );
  }

  postApiV1MarketingInfluencers<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/marketing/influencers", TResponse>(
      "POST /api/v1/marketing/influencers",
      options,
    );
  }

  postApiV1MarketingInfluencersBookings<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/marketing/influencers/bookings", TResponse>(
      "POST /api/v1/marketing/influencers/bookings",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdAccept<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/accept">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/accept",
      TResponse
    >(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/accept",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdApprove<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/approve">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/approve",
      TResponse
    >(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/approve",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/cancel">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/cancel",
      TResponse
    >(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/cancel",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdDeliver<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/deliver">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/deliver",
      TResponse
    >(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/deliver",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdReject<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/reject">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/reject",
      TResponse
    >(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/reject",
      options,
    );
  }

  postApiV1MarketingInventory<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/inventory"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/marketing/inventory", TResponse>(
      "POST /api/v1/marketing/inventory",
      options,
    );
  }

  postApiV1MarketingInventoryClick<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/inventory/click"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/marketing/inventory/click", TResponse>(
      "POST /api/v1/marketing/inventory/click",
      options,
    );
  }

  postApiV1MarketingPr<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/pr"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/marketing/pr", TResponse>(
      "POST /api/v1/marketing/pr",
      options,
    );
  }

  postApiV1MarketingPrByReleaseIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/pr/{releaseId}/cancel">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/marketing/pr/{releaseId}/cancel", TResponse>(
      "POST /api/v1/marketing/pr/{releaseId}/cancel",
      options,
    );
  }

  postApiV1MarketingPrByReleaseIdSubmit<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/pr/{releaseId}/submit">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/marketing/pr/{releaseId}/submit", TResponse>(
      "POST /api/v1/marketing/pr/{releaseId}/submit",
      options,
    );
  }

  postApiV1Mcps<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/mcps"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/mcps", TResponse>(
      "POST /api/v1/mcps",
      options,
    );
  }

  postApiV1McpsByMcpIdPublish<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/mcps/{mcpId}/publish">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/mcps/{mcpId}/publish", TResponse>(
      "POST /api/v1/mcps/{mcpId}/publish",
      options,
    );
  }

  postApiV1MeAccountDeletion<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/me/account-deletion"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/me/account-deletion", TResponse>(
      "POST /api/v1/me/account-deletion",
      options,
    );
  }

  postApiV1Messages<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/messages"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/messages", TResponse>(
      "POST /api/v1/messages",
      options,
    );
  }

  postApiV1ModelsStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/models/status"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/models/status", TResponse>(
      "POST /api/v1/models/status",
      options,
    );
  }

  postApiV1OauthIntents<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/oauth-intents"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/oauth-intents", TResponse>(
      "POST /api/v1/oauth-intents",
      options,
    );
  }

  postApiV1OauthIntentsByIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/oauth-intents/{id}/cancel">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/oauth-intents/{id}/cancel", TResponse>(
      "POST /api/v1/oauth-intents/{id}/cancel",
      options,
    );
  }

  postApiV1OauthByPlatformInitiate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/oauth/{platform}/initiate">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/oauth/{platform}/initiate", TResponse>(
      "POST /api/v1/oauth/{platform}/initiate",
      options,
    );
  }

  postApiV1OauthCallbackByProvider<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/oauth/callback/{provider}">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/oauth/callback/{provider}", TResponse>(
      "POST /api/v1/oauth/callback/{provider}",
      options,
    );
  }

  postApiV1OauthConnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/oauth/connect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/oauth/connect", TResponse>(
      "POST /api/v1/oauth/connect",
      options,
    );
  }

  postApiV1OauthInitiate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/oauth/initiate"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/oauth/initiate", TResponse>(
      "POST /api/v1/oauth/initiate",
      options,
    );
  }

  postApiV1Outreachr<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/outreachr"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/outreachr", TResponse>(
      "POST /api/v1/outreachr",
      options,
    );
  }

  postApiV1PaymentRequests<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/payment-requests"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/payment-requests", TResponse>(
      "POST /api/v1/payment-requests",
      options,
    );
  }

  postApiV1PaymentRequestsByIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/payment-requests/{id}/cancel">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/payment-requests/{id}/cancel", TResponse>(
      "POST /api/v1/payment-requests/{id}/cancel",
      options,
    );
  }

  postApiV1PaymentRequestsByIdExpire<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/payment-requests/{id}/expire">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/payment-requests/{id}/expire", TResponse>(
      "POST /api/v1/payment-requests/{id}/expire",
      options,
    );
  }

  postApiV1PiiScrubJobs<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/pii-scrub/jobs"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/pii-scrub/jobs", TResponse>(
      "POST /api/v1/pii-scrub/jobs",
      options,
    );
  }

  postApiV1ProxyBirdeyeByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/proxy/birdeye/{path}">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/proxy/birdeye/{path}", TResponse>(
      "POST /api/v1/proxy/birdeye/{path}",
      options,
    );
  }

  postApiV1ProxyEvmRpcByChain<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/proxy/evm-rpc/{chain}">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/proxy/evm-rpc/{chain}", TResponse>(
      "POST /api/v1/proxy/evm-rpc/{chain}",
      options,
    );
  }

  postApiV1ProxySolanaRpc<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/proxy/solana-rpc"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/proxy/solana-rpc", TResponse>(
      "POST /api/v1/proxy/solana-rpc",
      options,
    );
  }

  postApiV1Redemptions<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/redemptions"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/redemptions", TResponse>(
      "POST /api/v1/redemptions",
      options,
    );
  }

  postApiV1ReferralsApply<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/referrals/apply"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/referrals/apply", TResponse>(
      "POST /api/v1/referrals/apply",
      options,
    );
  }

  postApiV1RemoteHosts<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/hosts"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/remote/hosts", TResponse>(
      "POST /api/v1/remote/hosts",
      options,
    );
  }

  postApiV1RemoteHostsByIdManagedNetworkActivate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/hosts/{id}/managed-network/activate">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/remote/hosts/{id}/managed-network/activate",
      TResponse
    >("POST /api/v1/remote/hosts/{id}/managed-network/activate", options);
  }

  postApiV1RemoteHostsByIdRevoke<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/hosts/{id}/revoke">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/remote/hosts/{id}/revoke", TResponse>(
      "POST /api/v1/remote/hosts/{id}/revoke",
      options,
    );
  }

  postApiV1RemotePair<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/pair"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/remote/pair", TResponse>(
      "POST /api/v1/remote/pair",
      options,
    );
  }

  postApiV1RemoteSessions<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/remote/sessions", TResponse>(
      "POST /api/v1/remote/sessions",
      options,
    );
  }

  postApiV1RemoteSessionsByIdActivate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/activate">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/remote/sessions/{id}/activate", TResponse>(
      "POST /api/v1/remote/sessions/{id}/activate",
      options,
    );
  }

  postApiV1RemoteSessionsByIdCommands<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/commands">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/remote/sessions/{id}/commands", TResponse>(
      "POST /api/v1/remote/sessions/{id}/commands",
      options,
    );
  }

  postApiV1RemoteSessionsByIdCommandsByCommandIdComplete<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/commands/{commandId}/complete">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/remote/sessions/{id}/commands/{commandId}/complete",
      TResponse
    >(
      "POST /api/v1/remote/sessions/{id}/commands/{commandId}/complete",
      options,
    );
  }

  postApiV1RemoteSessionsByIdCommandsByCommandIdStart<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/commands/{commandId}/start">,
  ): Promise<TResponse> {
    return this.call<
      "POST /api/v1/remote/sessions/{id}/commands/{commandId}/start",
      TResponse
    >("POST /api/v1/remote/sessions/{id}/commands/{commandId}/start", options);
  }

  postApiV1RemoteSessionsByIdRevoke<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/revoke">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/remote/sessions/{id}/revoke", TResponse>(
      "POST /api/v1/remote/sessions/{id}/revoke",
      options,
    );
  }

  postApiV1RemoteSessionsActivate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/activate"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/remote/sessions/activate", TResponse>(
      "POST /api/v1/remote/sessions/activate",
      options,
    );
  }

  postApiV1ReportsBug<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/reports/bug"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/reports/bug", TResponse>(
      "POST /api/v1/reports/bug",
      options,
    );
  }

  postApiV1Responses<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/responses"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/responses", TResponse>(
      "POST /api/v1/responses",
      options,
    );
  }

  postApiV1RpcByChain<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/rpc/{chain}">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/rpc/{chain}", TResponse>(
      "POST /api/v1/rpc/{chain}",
      options,
    );
  }

  postApiV1Search<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/search"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/search", TResponse>(
      "POST /api/v1/search",
      options,
    );
  }

  postApiV1SecurityAudit<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/security/audit"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/security/audit", TResponse>(
      "POST /api/v1/security/audit",
      options,
    );
  }

  postApiV1SensitiveRequests<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/sensitive-requests"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/sensitive-requests", TResponse>(
      "POST /api/v1/sensitive-requests",
      options,
    );
  }

  postApiV1SensitiveRequestsByIdCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/sensitive-requests/{id}/cancel">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/sensitive-requests/{id}/cancel", TResponse>(
      "POST /api/v1/sensitive-requests/{id}/cancel",
      options,
    );
  }

  postApiV1SensitiveRequestsByIdExpire<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/sensitive-requests/{id}/expire">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/sensitive-requests/{id}/expire", TResponse>(
      "POST /api/v1/sensitive-requests/{id}/expire",
      options,
    );
  }

  postApiV1SensitiveRequestsByIdSubmit<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/sensitive-requests/{id}/submit">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/sensitive-requests/{id}/submit", TResponse>(
      "POST /api/v1/sensitive-requests/{id}/submit",
      options,
    );
  }

  postApiV1SolanaRpc<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/solana/rpc"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/solana/rpc", TResponse>(
      "POST /api/v1/solana/rpc",
      options,
    );
  }

  postApiV1StewardTenants<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/steward/tenants"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/steward/tenants", TResponse>(
      "POST /api/v1/steward/tenants",
      options,
    );
  }

  postApiV1StripeCheckout<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/stripe/checkout"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/stripe/checkout", TResponse>(
      "POST /api/v1/stripe/checkout",
      options,
    );
  }

  postApiV1SubscriptionsCancel<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/subscriptions/cancel"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/subscriptions/cancel", TResponse>(
      "POST /api/v1/subscriptions/cancel",
      options,
    );
  }

  postApiV1SubscriptionsCancelUndo<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/subscriptions/cancel/undo"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/subscriptions/cancel/undo", TResponse>(
      "POST /api/v1/subscriptions/cancel/undo",
      options,
    );
  }

  postApiV1TelegramConnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/telegram/connect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/telegram/connect", TResponse>(
      "POST /api/v1/telegram/connect",
      options,
    );
  }

  postApiV1TelegramScanChats<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/telegram/scan-chats"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/telegram/scan-chats", TResponse>(
      "POST /api/v1/telegram/scan-chats",
      options,
    );
  }

  postApiV1Topup10<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/topup/10"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/topup/10", TResponse>(
      "POST /api/v1/topup/10",
      options,
    );
  }

  postApiV1Topup100<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/topup/100"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/topup/100", TResponse>(
      "POST /api/v1/topup/100",
      options,
    );
  }

  postApiV1Topup50<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/topup/50"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/topup/50", TResponse>(
      "POST /api/v1/topup/50",
      options,
    );
  }

  postApiV1TrackPageview<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/track/pageview"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/track/pageview", TResponse>(
      "POST /api/v1/track/pageview",
      options,
    );
  }

  postApiV1TwilioConnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/connect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/twilio/connect", TResponse>(
      "POST /api/v1/twilio/connect",
      options,
    );
  }

  postApiV1TwilioDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/twilio/disconnect", TResponse>(
      "POST /api/v1/twilio/disconnect",
      options,
    );
  }

  postApiV1TwilioVoiceCalls<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/voice/calls"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/twilio/voice/calls", TResponse>(
      "POST /api/v1/twilio/voice/calls",
      options,
    );
  }

  postApiV1TwilioVoiceInbound<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/voice/inbound"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/twilio/voice/inbound", TResponse>(
      "POST /api/v1/twilio/voice/inbound",
      options,
    );
  }

  postApiV1TwilioVoiceStatus<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/voice/status"> = {},
  ): Promise<CloudResponse<TResponse>> {
    return this.callBodyless<"POST /api/v1/twilio/voice/status", TResponse>(
      "POST /api/v1/twilio/voice/status",
      options,
    );
  }

  postApiV1TwitterConnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/twitter/connect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/twitter/connect", TResponse>(
      "POST /api/v1/twitter/connect",
      options,
    );
  }

  postApiV1TwitterPersonalMessage<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/twitter/personal-message"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/twitter/personal-message", TResponse>(
      "POST /api/v1/twitter/personal-message",
      options,
    );
  }

  postApiV1UserAvatar<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/user/avatar"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/user/avatar", TResponse>(
      "POST /api/v1/user/avatar",
      options,
    );
  }

  postApiV1UserWalletsProvision<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/user/wallets/provision"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/user/wallets/provision", TResponse>(
      "POST /api/v1/user/wallets/provision",
      options,
    );
  }

  postApiV1UserWalletsRpc<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/user/wallets/rpc"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/user/wallets/rpc", TResponse>(
      "POST /api/v1/user/wallets/rpc",
      options,
    );
  }

  postApiV1VoiceClone<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/voice/clone"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/voice/clone", TResponse>(
      "POST /api/v1/voice/clone",
      options,
    );
  }

  postApiV1VoiceSession<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/voice/session"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/voice/session", TResponse>(
      "POST /api/v1/voice/session",
      options,
    );
  }

  postApiV1VoiceSessionByIdRevoke<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/voice/session/{id}/revoke">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/voice/session/{id}/revoke", TResponse>(
      "POST /api/v1/voice/session/{id}/revoke",
      options,
    );
  }

  postApiV1VoiceSessionConsent<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/voice/session/consent"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/voice/session/consent", TResponse>(
      "POST /api/v1/voice/session/consent",
      options,
    );
  }

  postApiV1VoiceStt<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/voice/stt"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/voice/stt", TResponse>(
      "POST /api/v1/voice/stt",
      options,
    );
  }

  postApiV1VoiceTts(
    options: PublicRouteCallOptions<"POST /api/v1/voice/tts"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/voice/tts", options);
  }

  postApiV1WebPushSubscriptions<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/web-push/subscriptions"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/web-push/subscriptions", TResponse>(
      "POST /api/v1/web-push/subscriptions",
      options,
    );
  }

  postApiV1WhatsappConnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/whatsapp/connect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/whatsapp/connect", TResponse>(
      "POST /api/v1/whatsapp/connect",
      options,
    );
  }

  postApiV1WhatsappDisconnect<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/whatsapp/disconnect"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/whatsapp/disconnect", TResponse>(
      "POST /api/v1/whatsapp/disconnect",
      options,
    );
  }

  postApiV1XDmsConversationsSend<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x/dms/conversations/send"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x/dms/conversations/send", TResponse>(
      "POST /api/v1/x/dms/conversations/send",
      options,
    );
  }

  postApiV1XDmsCurate<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x/dms/curate"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x/dms/curate", TResponse>(
      "POST /api/v1/x/dms/curate",
      options,
    );
  }

  postApiV1XDmsGroups<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x/dms/groups"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x/dms/groups", TResponse>(
      "POST /api/v1/x/dms/groups",
      options,
    );
  }

  postApiV1XDmsSend<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x/dms/send"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x/dms/send", TResponse>(
      "POST /api/v1/x/dms/send",
      options,
    );
  }

  postApiV1XPosts<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x/posts"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x/posts", TResponse>(
      "POST /api/v1/x/posts",
      options,
    );
  }

  postApiV1X402Requests<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x402/requests"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x402/requests", TResponse>(
      "POST /api/v1/x402/requests",
      options,
    );
  }

  postApiV1X402RequestsByIdSettle<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x402/requests/{id}/settle">,
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x402/requests/{id}/settle", TResponse>(
      "POST /api/v1/x402/requests/{id}/settle",
      options,
    );
  }

  postApiV1X402Settle<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x402/settle"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x402/settle", TResponse>(
      "POST /api/v1/x402/settle",
      options,
    );
  }

  postApiV1X402Verify<TResponse = unknown>(
    options: PublicRouteCallOptions<"POST /api/v1/x402/verify"> = {},
  ): Promise<TResponse> {
    return this.call<"POST /api/v1/x402/verify", TResponse>(
      "POST /api/v1/x402/verify",
      options,
    );
  }

  putApiV1AdvertisingCampaignsByIdDayparting<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/advertising/campaigns/{id}/dayparting">,
  ): Promise<TResponse> {
    return this.call<
      "PUT /api/v1/advertising/campaigns/{id}/dayparting",
      TResponse
    >("PUT /api/v1/advertising/campaigns/{id}/dayparting", options);
  }

  putApiV1Affiliates<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/affiliates"> = {},
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/affiliates", TResponse>(
      "PUT /api/v1/affiliates",
      options,
    );
  }

  putApiV1AgentsByAgentIdMonetization<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/agents/{agentId}/monetization">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/agents/{agentId}/monetization", TResponse>(
      "PUT /api/v1/agents/{agentId}/monetization",
      options,
    );
  }

  putApiV1AgentsByAgentIdWorkflowsByWorkflowId<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/agents/{agentId}/workflows/{workflowId}">,
  ): Promise<TResponse> {
    return this.call<
      "PUT /api/v1/agents/{agentId}/workflows/{workflowId}",
      TResponse
    >("PUT /api/v1/agents/{agentId}/workflows/{workflowId}", options);
  }

  putApiV1ApisStorageObjects<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/apis/storage/objects/_">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/apis/storage/objects/_", TResponse>(
      "PUT /api/v1/apis/storage/objects/_",
      options,
    );
  }

  putApiV1AppsById<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/apps/{id}">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/apps/{id}", TResponse>(
      "PUT /api/v1/apps/{id}",
      options,
    );
  }

  putApiV1AppsByIdCharacters<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/apps/{id}/characters">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/apps/{id}/characters", TResponse>(
      "PUT /api/v1/apps/{id}/characters",
      options,
    );
  }

  putApiV1AppsByIdDatabase<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/apps/{id}/database">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/apps/{id}/database", TResponse>(
      "PUT /api/v1/apps/{id}/database",
      options,
    );
  }

  putApiV1AppsByIdMonetization<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/apps/{id}/monetization">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/apps/{id}/monetization", TResponse>(
      "PUT /api/v1/apps/{id}/monetization",
      options,
    );
  }

  putApiV1BillingSettings<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/billing/settings"> = {},
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/billing/settings", TResponse>(
      "PUT /api/v1/billing/settings",
      options,
    );
  }

  putApiV1ConnectionsByPlatform<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/connections/{platform}">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/connections/{platform}", TResponse>(
      "PUT /api/v1/connections/{platform}",
      options,
    );
  }

  putApiV1ElizaAgentsByAgentIdApiByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<TResponse> {
    return this.call<
      "PUT /api/v1/eliza/agents/{agentId}/api/{path}",
      TResponse
    >("PUT /api/v1/eliza/agents/{agentId}/api/{path}", options);
  }

  putApiV1ElizaAgentsByAgentIdApiIdentityUri<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/eliza/agents/{agentId}/api/identity/uri">,
  ): Promise<TResponse> {
    return this.call<
      "PUT /api/v1/eliza/agents/{agentId}/api/identity/uri",
      TResponse
    >("PUT /api/v1/eliza/agents/{agentId}/api/identity/uri", options);
  }

  putApiV1ElizaAgentsByAgentIdApiWalletByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/eliza/agents/{agentId}/api/wallet/{path}">,
  ): Promise<TResponse> {
    return this.call<
      "PUT /api/v1/eliza/agents/{agentId}/api/wallet/{path}",
      TResponse
    >("PUT /api/v1/eliza/agents/{agentId}/api/wallet/{path}", options);
  }

  putApiV1McpsByMcpId<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/mcps/{mcpId}">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/mcps/{mcpId}", TResponse>(
      "PUT /api/v1/mcps/{mcpId}",
      options,
    );
  }

  putApiV1ProxyBirdeyeByPath<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/proxy/birdeye/{path}">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/proxy/birdeye/{path}", TResponse>(
      "PUT /api/v1/proxy/birdeye/{path}",
      options,
    );
  }

  putApiV1RemoteSessionsByIdActivate<TResponse = unknown>(
    options: PublicRouteCallOptions<"PUT /api/v1/remote/sessions/{id}/activate">,
  ): Promise<TResponse> {
    return this.call<"PUT /api/v1/remote/sessions/{id}/activate", TResponse>(
      "PUT /api/v1/remote/sessions/{id}/activate",
      options,
    );
  }

  deleteApiElevenlabsVoicesByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/elevenlabs/voices/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/elevenlabs/voices/{id}", options);
  }

  deleteApiV1AdvertisingAccountsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/accounts/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/advertising/accounts/{id}", options);
  }

  deleteApiV1AdvertisingAudienceSegmentsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/audience-segments/{id}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/advertising/audience-segments/{id}",
      options,
    );
  }

  deleteApiV1AdvertisingCampaignsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/campaigns/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/advertising/campaigns/{id}", options);
  }

  deleteApiV1AdvertisingCampaignsByIdReportShareByShareIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/campaigns/{id}/report/share/{shareId}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/advertising/campaigns/{id}/report/share/{shareId}",
      options,
    );
  }

  deleteApiV1AdvertisingCreativesByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/advertising/creatives/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/advertising/creatives/{id}", options);
  }

  deleteApiV1AgentsByAgentIdPublishRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/agents/{agentId}/publish">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/agents/{agentId}/publish", options);
  }

  deleteApiV1AgentsByAgentIdWorkflowsByWorkflowIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/agents/{agentId}/workflows/{workflowId}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/agents/{agentId}/workflows/{workflowId}",
      options,
    );
  }

  deleteApiV1ApiKeysByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/api-keys/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/api-keys/{id}", options);
  }

  deleteApiV1ApiKeysCurrentRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/api-keys/current"> = {},
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/api-keys/current", options);
  }

  deleteApiV1ApisStorageObjectsRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/apis/storage/objects/_">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/apis/storage/objects/_", options);
  }

  deleteApiV1AppAuthMobileCredentialsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/app-auth/mobile/credentials/{id}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/app-auth/mobile/credentials/{id}",
      options,
    );
  }

  deleteApiV1AppsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/apps/{id}", options);
  }

  deleteApiV1AppsByIdDiscordAutomationRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/discord-automation">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/apps/{id}/discord-automation", options);
  }

  deleteApiV1AppsByIdDomainsRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/domains">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/apps/{id}/domains", options);
  }

  deleteApiV1AppsByIdDomainsByDomainDnsByRecordIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/domains/{domain}/dns/{recordId}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/apps/{id}/domains/{domain}/dns/{recordId}",
      options,
    );
  }

  deleteApiV1AppsByIdFrontendByDeploymentIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/frontend/{deploymentId}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/apps/{id}/frontend/{deploymentId}",
      options,
    );
  }

  deleteApiV1AppsByIdTelegramAutomationRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/telegram-automation">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/apps/{id}/telegram-automation",
      options,
    );
  }

  deleteApiV1AppsByIdTwitterAutomationRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/apps/{id}/twitter-automation">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/apps/{id}/twitter-automation", options);
  }

  deleteApiV1BlooioDisconnectRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/blooio/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/blooio/disconnect", options);
  }

  deleteApiV1BrowserSessionsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/browser/sessions/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/browser/sessions/{id}", options);
  }

  deleteApiV1ConnectionsByPlatformRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/connections/{platform}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/connections/{platform}", options);
  }

  deleteApiV1ContainersByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/containers/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/containers/{id}", options);
  }

  deleteApiV1DiscordConnectionsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/discord/connections/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/discord/connections/{id}", options);
  }

  deleteApiV1DocumentsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/documents/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/documents/{id}", options);
  }

  deleteApiV1DocumentsPreUploadRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/documents/pre-upload"> = {},
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/documents/pre-upload", options);
  }

  deleteApiV1ElizaAgentsByAgentIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/eliza/agents/{agentId}", options);
  }

  deleteApiV1ElizaAgentsByAgentIdApiByPathRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/eliza/agents/{agentId}/api/{path}",
      options,
    );
  }

  deleteApiV1ElizaAgentsByAgentIdApiConversationsByConversationIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}",
      options,
    );
  }

  deleteApiV1ElizaAgentsByAgentIdDiscordRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}/discord">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/eliza/agents/{agentId}/discord",
      options,
    );
  }

  deleteApiV1ElizaAgentsByAgentIdGithubRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/agents/{agentId}/github">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/eliza/agents/{agentId}/github",
      options,
    );
  }

  deleteApiV1ElizaGatewayRelaySessionsBySessionIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/gateway-relay/sessions/{sessionId}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/eliza/gateway-relay/sessions/{sessionId}",
      options,
    );
  }

  deleteApiV1ElizaGoogleCalendarEventsByEventIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/eliza/google/calendar/events/{eventId}">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/eliza/google/calendar/events/{eventId}",
      options,
    );
  }

  deleteApiV1FilesByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/files/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/files/{id}", options);
  }

  deleteApiV1GalleryByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/gallery/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/gallery/{id}", options);
  }

  deleteApiV1MarketingInventoryBySlotIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/marketing/inventory/{slotId}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/marketing/inventory/{slotId}", options);
  }

  deleteApiV1McpsByMcpIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/mcps/{mcpId}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/mcps/{mcpId}", options);
  }

  deleteApiV1McpsByMcpIdPublishRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/mcps/{mcpId}/publish">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/mcps/{mcpId}/publish", options);
  }

  deleteApiV1OauthConnectionsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/oauth/connections/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/oauth/connections/{id}", options);
  }

  deleteApiV1ProxyBirdeyeByPathRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/proxy/birdeye/{path}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/proxy/birdeye/{path}", options);
  }

  deleteApiV1RemoteSessionsByIdActivateRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/remote/sessions/{id}/activate">,
  ): Promise<Response> {
    return this.callRaw(
      "DELETE /api/v1/remote/sessions/{id}/activate",
      options,
    );
  }

  deleteApiV1SessionsByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/sessions/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/sessions/{id}", options);
  }

  deleteApiV1TelegramDisconnectRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/telegram/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/telegram/disconnect", options);
  }

  deleteApiV1TwilioDisconnectRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/twilio/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/twilio/disconnect", options);
  }

  deleteApiV1TwilioVoiceCallsByCallSidRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/twilio/voice/calls/{callSid}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/twilio/voice/calls/{callSid}", options);
  }

  deleteApiV1TwitterDisconnectRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/twitter/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/twitter/disconnect", options);
  }

  deleteApiV1VoiceByIdRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/voice/{id}">,
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/voice/{id}", options);
  }

  deleteApiV1WebPushSubscriptionsRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/web-push/subscriptions"> = {},
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/web-push/subscriptions", options);
  }

  deleteApiV1WhatsappDisconnectRaw(
    options: PublicRouteCallOptions<"DELETE /api/v1/whatsapp/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("DELETE /api/v1/whatsapp/disconnect", options);
  }

  getApiElevenlabsVoicesRaw(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/elevenlabs/voices", options);
  }

  getApiElevenlabsVoicesByIdRaw(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/elevenlabs/voices/{id}", options);
  }

  getApiElevenlabsVoicesJobsRaw(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices/jobs"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/elevenlabs/voices/jobs", options);
  }

  getApiElevenlabsVoicesUserRaw(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices/user"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/elevenlabs/voices/user", options);
  }

  getApiElevenlabsVoicesVerifyByIdRaw(
    options: PublicRouteCallOptions<"GET /api/elevenlabs/voices/verify/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/elevenlabs/voices/verify/{id}", options);
  }

  getApiV1AdvertisingAccountsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/accounts"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/accounts", options);
  }

  getApiV1AdvertisingAccountsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/accounts/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/accounts/{id}", options);
  }

  getApiV1AdvertisingAccountsByIdMediaRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/accounts/{id}/media">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/accounts/{id}/media", options);
  }

  getApiV1AdvertisingAudienceSegmentsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/audience-segments"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/audience-segments", options);
  }

  getApiV1AdvertisingAudienceSegmentsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/audience-segments/{id}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/advertising/audience-segments/{id}",
      options,
    );
  }

  getApiV1AdvertisingCampaignsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/campaigns", options);
  }

  getApiV1AdvertisingCampaignsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/campaigns/{id}", options);
  }

  getApiV1AdvertisingCampaignsByIdAnalyticsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/analytics">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/advertising/campaigns/{id}/analytics",
      options,
    );
  }

  getApiV1AdvertisingCampaignsByIdAttributionRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/attribution">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/advertising/campaigns/{id}/attribution",
      options,
    );
  }

  getApiV1AdvertisingCampaignsByIdCreativesRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/creatives">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/advertising/campaigns/{id}/creatives",
      options,
    );
  }

  getApiV1AdvertisingCampaignsByIdDaypartingRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/dayparting">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/advertising/campaigns/{id}/dayparting",
      options,
    );
  }

  getApiV1AdvertisingCampaignsByIdReportRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/campaigns/{id}/report">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/advertising/campaigns/{id}/report",
      options,
    );
  }

  getApiV1AdvertisingConversionsTrackRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/conversions/track"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/conversions/track", options);
  }

  getApiV1AdvertisingCreativesByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/creatives/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/creatives/{id}", options);
  }

  getApiV1AdvertisingReportsByTokenRaw(
    options: PublicRouteCallOptions<"GET /api/v1/advertising/reports/{token}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/advertising/reports/{token}", options);
  }

  getApiV1AffiliatesRaw(
    options: PublicRouteCallOptions<"GET /api/v1/affiliates"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/affiliates", options);
  }

  getApiV1AgentsByAgentIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/agents/{agentId}", options);
  }

  getApiV1AgentsByAgentIdLogsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/logs">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/agents/{agentId}/logs", options);
  }

  getApiV1AgentsByAgentIdMonetizationRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/monetization">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/agents/{agentId}/monetization", options);
  }

  getApiV1AgentsByAgentIdStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/status">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/agents/{agentId}/status", options);
  }

  getApiV1AgentsByAgentIdUsageRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/usage">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/agents/{agentId}/usage", options);
  }

  getApiV1AgentsByAgentIdWorkflowsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/workflows">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/agents/{agentId}/workflows", options);
  }

  getApiV1AgentsByAgentIdWorkflowsByWorkflowIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/workflows/{workflowId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/agents/{agentId}/workflows/{workflowId}",
      options,
    );
  }

  getApiV1AgentsByAgentIdWorkflowsExecutionsByExecutionIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/{agentId}/workflows/executions/{executionId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/agents/{agentId}/workflows/executions/{executionId}",
      options,
    );
  }

  getApiV1AgentsByTokenRaw(
    options: PublicRouteCallOptions<"GET /api/v1/agents/by-token"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/agents/by-token", options);
  }

  getApiV1ApiKeysRaw(
    options: PublicRouteCallOptions<"GET /api/v1/api-keys"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/api-keys", options);
  }

  getApiV1ApisBirdeyeByPathRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apis/birdeye/{path}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apis/birdeye/{path}", options);
  }

  getApiV1ApisDexscreenerByPathRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apis/dexscreener/{path}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apis/dexscreener/{path}", options);
  }

  getApiV1ApisStorageListRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apis/storage/list">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apis/storage/list", options);
  }

  getApiV1ApisStorageObjectsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apis/storage/objects/_">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apis/storage/objects/_", options);
  }

  getApiV1AppAuthMobileConfigRaw(
    options: PublicRouteCallOptions<"GET /api/v1/app-auth/mobile/config"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/app-auth/mobile/config", options);
  }

  getApiV1AppAuthMobileCredentialsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/app-auth/mobile/credentials"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/app-auth/mobile/credentials", options);
  }

  getApiV1AppAuthSessionRaw(
    options: PublicRouteCallOptions<"GET /api/v1/app-auth/session"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/app-auth/session", options);
  }

  getApiV1AppCreditsBalanceRaw(
    options: PublicRouteCallOptions<"GET /api/v1/app-credits/balance"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/app-credits/balance", options);
  }

  getApiV1AppCreditsVerifyRaw(
    options: PublicRouteCallOptions<"GET /api/v1/app-credits/verify"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/app-credits/verify", options);
  }

  getApiV1ApprovalRequestsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/approval-requests"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/approval-requests", options);
  }

  getApiV1ApprovalRequestsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/approval-requests/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/approval-requests/{id}", options);
  }

  getApiV1AppsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps", options);
  }

  getApiV1AppsIngressAskRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps-ingress/ask"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps-ingress/ask", options);
  }

  getApiV1AppsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}", options);
  }

  getApiV1AppsByIdAnalyticsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/analytics">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/analytics", options);
  }

  getApiV1AppsByIdAnalyticsRequestsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/analytics/requests">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/analytics/requests", options);
  }

  getApiV1AppsByIdBackupRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/backup">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/backup", options);
  }

  getApiV1AppsByIdBillingAccountRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/billing/account">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/billing/account", options);
  }

  getApiV1AppsByIdCharactersRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/characters">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/characters", options);
  }

  getApiV1AppsByIdChargesRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/charges">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/charges", options);
  }

  getApiV1AppsByIdChargesByChargeIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/charges/{chargeId}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/charges/{chargeId}", options);
  }

  getApiV1AppsByIdDatabaseRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/database">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/database", options);
  }

  getApiV1AppsByIdDeployStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/deploy/status">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/deploy/status", options);
  }

  getApiV1AppsByIdDiscordAutomationRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/discord-automation">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/discord-automation", options);
  }

  getApiV1AppsByIdDomainsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/domains">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/domains", options);
  }

  getApiV1AppsByIdDomainsByDomainDnsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/domains/{domain}/dns">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/domains/{domain}/dns", options);
  }

  getApiV1AppsByIdDomainsByDomainDnsByRecordIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/domains/{domain}/dns/{recordId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/apps/{id}/domains/{domain}/dns/{recordId}",
      options,
    );
  }

  getApiV1AppsByIdEarningsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/earnings">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/earnings", options);
  }

  getApiV1AppsByIdEarningsHistoryRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/earnings/history">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/earnings/history", options);
  }

  getApiV1AppsByIdFrontendRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/frontend">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/frontend", options);
  }

  getApiV1AppsByIdFrontendByDeploymentIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/frontend/{deploymentId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/apps/{id}/frontend/{deploymentId}",
      options,
    );
  }

  getApiV1AppsByIdFrontendPreviewByPathRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/frontend/preview/{[...path]}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/apps/{id}/frontend/preview/{[...path]}",
      options,
    );
  }

  getApiV1AppsByIdMonetizationRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/monetization">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/monetization", options);
  }

  getApiV1AppsByIdPromoteRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/promote">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/promote", options);
  }

  getApiV1AppsByIdPromoteAnalyticsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/promote/analytics">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/promote/analytics", options);
  }

  getApiV1AppsByIdPromoteAssetsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/promote/assets">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/promote/assets", options);
  }

  getApiV1AppsByIdPublicRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/public">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/public", options);
  }

  getApiV1AppsByIdReviewRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/review">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/review", options);
  }

  getApiV1AppsByIdTelegramAutomationRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/telegram-automation">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/telegram-automation", options);
  }

  getApiV1AppsByIdTwitterAutomationRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/twitter-automation">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/twitter-automation", options);
  }

  getApiV1AppsByIdUsersRaw(
    options: PublicRouteCallOptions<"GET /api/v1/apps/{id}/users">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/apps/{id}/users", options);
  }

  getApiV1BallotsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/ballots"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/ballots", options);
  }

  getApiV1BallotsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/ballots/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/ballots/{id}", options);
  }

  getApiV1BillingActiveRaw(
    options: PublicRouteCallOptions<"GET /api/v1/billing/active"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/billing/active", options);
  }

  getApiV1BillingLedgerRaw(
    options: PublicRouteCallOptions<"GET /api/v1/billing/ledger"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/billing/ledger", options);
  }

  getApiV1BillingLimitsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/billing/limits"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/billing/limits", options);
  }

  getApiV1BillingResourcesByIdCancelRaw(
    options: PublicRouteCallOptions<"GET /api/v1/billing/resources/{id}/cancel">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/billing/resources/{id}/cancel", options);
  }

  getApiV1BillingSettingsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/billing/settings"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/billing/settings", options);
  }

  getApiV1BlooioStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/blooio/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/blooio/status", options);
  }

  getApiV1BrowserSessionsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/browser/sessions"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/browser/sessions", options);
  }

  getApiV1BrowserSessionsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/browser/sessions/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/browser/sessions/{id}", options);
  }

  getApiV1BrowserSessionsByIdSnapshotRaw(
    options: PublicRouteCallOptions<"GET /api/v1/browser/sessions/{id}/snapshot">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/browser/sessions/{id}/snapshot", options);
  }

  getApiV1ChainNftsByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/chain/nfts/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/chain/nfts/{chain}/{address}", options);
  }

  getApiV1ChainTokensByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/chain/tokens/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/chain/tokens/{chain}/{address}", options);
  }

  getApiV1ChainTransfersByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/chain/transfers/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/chain/transfers/{chain}/{address}",
      options,
    );
  }

  getApiV1CliAuthBySessionTokenRaw(
    options: PublicRouteCallOptions<"GET /api/v1/cli-auth/{session}/token">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/cli-auth/{session}/token", options);
  }

  getApiV1ConnectionsByPlatformRaw(
    options: PublicRouteCallOptions<"GET /api/v1/connections/{platform}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/connections/{platform}", options);
  }

  getApiV1ConnectionsAccountsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/connections/accounts"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/connections/accounts", options);
  }

  getApiV1ConnectionsAccountsByAccountIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/connections/accounts/{accountId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/connections/accounts/{accountId}",
      options,
    );
  }

  getApiV1ContainersRaw(
    options: PublicRouteCallOptions<"GET /api/v1/containers"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/containers", options);
  }

  getApiV1CreditsBalanceRaw(
    options: PublicRouteCallOptions<"GET /api/v1/credits/balance"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/credits/balance", options);
  }

  getApiV1CreditsSummaryRaw(
    options: PublicRouteCallOptions<"GET /api/v1/credits/summary"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/credits/summary", options);
  }

  getApiV1CreditsVerifyRaw(
    options: PublicRouteCallOptions<"GET /api/v1/credits/verify"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/credits/verify", options);
  }

  getApiV1DeviceBusDevicesByDeviceIdIntentsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/device-bus/devices/{deviceId}/intents">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/device-bus/devices/{deviceId}/intents",
      options,
    );
  }

  getApiV1DiscordCallbackRaw(
    options: PublicRouteCallOptions<"GET /api/v1/discord/callback"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/discord/callback", options);
  }

  getApiV1DiscordChannelsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/discord/channels"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/discord/channels", options);
  }

  getApiV1DiscordConnectionsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/discord/connections"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/discord/connections", options);
  }

  getApiV1DiscordConnectionsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/discord/connections/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/discord/connections/{id}", options);
  }

  getApiV1DiscordGuildsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/discord/guilds"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/discord/guilds", options);
  }

  getApiV1DiscordOauthRaw(
    options: PublicRouteCallOptions<"GET /api/v1/discord/oauth"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/discord/oauth", options);
  }

  getApiV1DiscordStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/discord/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/discord/status", options);
  }

  getApiV1DiscoveryRaw(
    options: PublicRouteCallOptions<"GET /api/v1/discovery"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/discovery", options);
  }

  getApiV1DocumentsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/documents"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/documents", options);
  }

  getApiV1DocumentsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/documents/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/documents/{id}", options);
  }

  getApiV1DocumentsCheckRaw(
    options: PublicRouteCallOptions<"GET /api/v1/documents/check"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/documents/check", options);
  }

  getApiV1DomainsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/domains"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/domains", options);
  }

  getApiV1DomainsResolveRaw(
    options: PublicRouteCallOptions<"GET /api/v1/domains/resolve"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/domains/resolve", options);
  }

  getApiV1ElizaAgentsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/agents", options);
  }

  getApiV1ElizaAgentsByAgentIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/agents/{agentId}", options);
  }

  getApiV1ElizaAgentsByAgentIdApiByPathRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/api/{path}",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdApiConversationsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/conversations">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/api/conversations",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdApiConversationsByConversationIdMessagesRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdApiHealthRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/health">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/api/health",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdApiIdentityRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/identity">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/api/identity",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdApiIdentityOnchainRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/identity/onchain">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/api/identity/onchain",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdApiWalletByPathRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/api/wallet/{path}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/api/wallet/{path}",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdBackupsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/backups">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/agents/{agentId}/backups", options);
  }

  getApiV1ElizaAgentsByAgentIdDiscordRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/discord">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/agents/{agentId}/discord", options);
  }

  getApiV1ElizaAgentsByAgentIdGithubRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/github">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/agents/{agentId}/github", options);
  }

  getApiV1ElizaAgentsByAgentIdGithubTokenRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/github/token">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/github/token",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdLifeopsScheduleMergedStateRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/lifeops/schedule/merged-state">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/lifeops/schedule/merged-state",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdUpgradeTierRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/upgrade-tier">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/upgrade-tier",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdUpgradeTierAdoptExistingRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing",
      options,
    );
  }

  getApiV1ElizaAgentsByAgentIdWalletRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/agents/{agentId}/wallet">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/agents/{agentId}/wallet", options);
  }

  getApiV1ElizaGatewayRelaySessionsBySessionIdNextRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/gateway-relay/sessions/{sessionId}/next">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/gateway-relay/sessions/{sessionId}/next",
      options,
    );
  }

  getApiV1ElizaGithubOauthCompleteRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/github-oauth-complete"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/github-oauth-complete", options);
  }

  getApiV1ElizaGoogleAccountsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/accounts"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/google/accounts", options);
  }

  getApiV1ElizaGoogleCalendarCalendarsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/calendar/calendars"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/google/calendar/calendars", options);
  }

  getApiV1ElizaGoogleCalendarFeedRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/calendar/feed"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/google/calendar/feed", options);
  }

  getApiV1ElizaGoogleGmailReadRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/gmail/read"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/google/gmail/read", options);
  }

  getApiV1ElizaGoogleGmailSearchRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/gmail/search"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/google/gmail/search", options);
  }

  getApiV1ElizaGoogleGmailSubscriptionHeadersRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/gmail/subscription-headers"> = {},
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/google/gmail/subscription-headers",
      options,
    );
  }

  getApiV1ElizaGoogleGmailTriageRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/gmail/triage"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/google/gmail/triage", options);
  }

  getApiV1ElizaGoogleStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/google/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/google/status", options);
  }

  getApiV1ElizaLaunchSessionsBySessionIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/launch-sessions/{sessionId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/eliza/launch-sessions/{sessionId}",
      options,
    );
  }

  getApiV1ElizaLifeopsGithubCompleteRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/lifeops/github-complete"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/lifeops/github-complete", options);
  }

  getApiV1ElizaPaypalPopupCallbackRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/paypal/popup-callback"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/paypal/popup-callback", options);
  }

  getApiV1ElizaPaypalStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/paypal/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/paypal/status", options);
  }

  getApiV1ElizaPersonalRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/personal"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/personal", options);
  }

  getApiV1ElizaPlaidStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/eliza/plaid/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/eliza/plaid/status", options);
  }

  getApiV1FilesRaw(
    options: PublicRouteCallOptions<"GET /api/v1/files"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/files", options);
  }

  getApiV1FilesByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/files/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/files/{id}", options);
  }

  getApiV1GalleryRaw(
    options: PublicRouteCallOptions<"GET /api/v1/gallery"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/gallery", options);
  }

  getApiV1GalleryExploreRaw(
    options: PublicRouteCallOptions<"GET /api/v1/gallery/explore"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/gallery/explore", options);
  }

  getApiV1GalleryStatsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/gallery/stats"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/gallery/stats", options);
  }

  getApiV1HfProxyByPathRaw(
    options: PublicRouteCallOptions<"GET /api/v1/hf-proxy/{path}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/hf-proxy/{path}", options);
  }

  getApiV1HostedFrontendServeByPathRaw(
    options: PublicRouteCallOptions<"GET /api/v1/hosted-frontend/serve/{[...path]}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/hosted-frontend/serve/{[...path]}",
      options,
    );
  }

  getApiV1JobsByJobIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/jobs/{jobId}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/jobs/{jobId}", options);
  }

  getApiV1MarketCandlesByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/candles/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/market/candles/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketPortfolioByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/portfolio/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/market/portfolio/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketPreviewPortfolioByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/portfolio/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/market/preview/portfolio/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketPreviewPredictionsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/predictions"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/market/preview/predictions", options);
  }

  getApiV1MarketPreviewPriceByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/price/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/market/preview/price/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketPreviewTokenByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/token/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/market/preview/token/{chain}/{address}",
      options,
    );
  }

  getApiV1MarketPreviewWalletOverviewRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/preview/wallet-overview"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/market/preview/wallet-overview", options);
  }

  getApiV1MarketPriceByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/price/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/market/price/{chain}/{address}", options);
  }

  getApiV1MarketTokenByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/token/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/market/token/{chain}/{address}", options);
  }

  getApiV1MarketTradesByChainByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/market/trades/{chain}/{address}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/market/trades/{chain}/{address}", options);
  }

  getApiV1MarketingInfluencersRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/influencers"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/marketing/influencers", options);
  }

  getApiV1MarketingInfluencersBookingsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/influencers/bookings"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/marketing/influencers/bookings", options);
  }

  getApiV1MarketingInventoryRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/inventory"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/marketing/inventory", options);
  }

  getApiV1MarketingInventoryBySlotIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/inventory/{slotId}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/marketing/inventory/{slotId}", options);
  }

  getApiV1MarketingInventoryBySlotIdAnalyticsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/inventory/{slotId}/analytics">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/marketing/inventory/{slotId}/analytics",
      options,
    );
  }

  getApiV1MarketingInventoryServeRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/inventory/serve"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/marketing/inventory/serve", options);
  }

  getApiV1MarketingPrRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/pr"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/marketing/pr", options);
  }

  getApiV1MarketingPrByReleaseIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/pr/{releaseId}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/marketing/pr/{releaseId}", options);
  }

  getApiV1MarketingPrByReleaseIdCoverageRaw(
    options: PublicRouteCallOptions<"GET /api/v1/marketing/pr/{releaseId}/coverage">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/marketing/pr/{releaseId}/coverage",
      options,
    );
  }

  getApiV1McpsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/mcps"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/mcps", options);
  }

  getApiV1McpsByMcpIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/mcps/{mcpId}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/mcps/{mcpId}", options);
  }

  getApiV1MeAccountDeletionRaw(
    options: PublicRouteCallOptions<"GET /api/v1/me/account-deletion"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/me/account-deletion", options);
  }

  getApiV1MeMfaRaw(
    options: PublicRouteCallOptions<"GET /api/v1/me/mfa"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/me/mfa", options);
  }

  getApiV1ModelsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/models"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/models", options);
  }

  getApiV1ModelsByModelRaw(
    options: PublicRouteCallOptions<"GET /api/v1/models/{model}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/models/{model}", options);
  }

  getApiV1ModelsStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/models/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/models/status", options);
  }

  getApiV1OauthIntentsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth-intents"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth-intents", options);
  }

  getApiV1OauthIntentsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth-intents/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth-intents/{id}", options);
  }

  getApiV1OauthByPlatformCallbackRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/{platform}/callback">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/{platform}/callback", options);
  }

  getApiV1OauthCallbackRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/callback"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/callback", options);
  }

  getApiV1OauthCallbackByProviderRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/callback/{provider}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/callback/{provider}", options);
  }

  getApiV1OauthConnectionsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/connections"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/connections", options);
  }

  getApiV1OauthConnectionsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/connections/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/connections/{id}", options);
  }

  getApiV1OauthConnectionsByIdTokenRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/connections/{id}/token">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/connections/{id}/token", options);
  }

  getApiV1OauthInitiateRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/initiate"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/initiate", options);
  }

  getApiV1OauthProvidersRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/providers"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/providers", options);
  }

  getApiV1OauthStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/status", options);
  }

  getApiV1OauthSuccessProofVerifyRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/success-proof/verify"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/success-proof/verify", options);
  }

  getApiV1OauthTokenByPlatformRaw(
    options: PublicRouteCallOptions<"GET /api/v1/oauth/token/{platform}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/oauth/token/{platform}", options);
  }

  getApiV1OutreachrRaw(
    options: PublicRouteCallOptions<"GET /api/v1/outreachr"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/outreachr", options);
  }

  getApiV1PaymentRequestsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/payment-requests"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/payment-requests", options);
  }

  getApiV1PaymentRequestsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/payment-requests/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/payment-requests/{id}", options);
  }

  getApiV1PiiScrubJobsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/pii-scrub/jobs/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/pii-scrub/jobs/{id}", options);
  }

  getApiV1PricingSummaryRaw(
    options: PublicRouteCallOptions<"GET /api/v1/pricing/summary"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/pricing/summary", options);
  }

  getApiV1ProxyBirdeyeByPathRaw(
    options: PublicRouteCallOptions<"GET /api/v1/proxy/birdeye/{path}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/proxy/birdeye/{path}", options);
  }

  getApiV1RedemptionsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/redemptions", options);
  }

  getApiV1RedemptionsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/redemptions/{id}", options);
  }

  getApiV1RedemptionsBalanceRaw(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions/balance"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/redemptions/balance", options);
  }

  getApiV1RedemptionsQuoteRaw(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions/quote"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/redemptions/quote", options);
  }

  getApiV1RedemptionsStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/redemptions/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/redemptions/status", options);
  }

  getApiV1ReferralsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/referrals"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/referrals", options);
  }

  getApiV1RemoteHostsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/remote/hosts"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/remote/hosts", options);
  }

  getApiV1RemoteSessionsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/remote/sessions"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/remote/sessions", options);
  }

  getApiV1RemoteSessionsByIdActivateRaw(
    options: PublicRouteCallOptions<"GET /api/v1/remote/sessions/{id}/activate">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/remote/sessions/{id}/activate", options);
  }

  getApiV1RemoteSessionsByIdCommandsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/remote/sessions/{id}/commands">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/remote/sessions/{id}/commands", options);
  }

  getApiV1RemoteSessionsByIdCommandsByCommandIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/remote/sessions/{id}/commands/{commandId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/remote/sessions/{id}/commands/{commandId}",
      options,
    );
  }

  getApiV1SensitiveRequestsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/sensitive-requests/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/sensitive-requests/{id}", options);
  }

  getApiV1SessionsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/sessions"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/sessions", options);
  }

  getApiV1SolanaAssetsByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/solana/assets/{address}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/solana/assets/{address}", options);
  }

  getApiV1SolanaMethodsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/solana/methods"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/solana/methods", options);
  }

  getApiV1SolanaTokenAccountsByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/solana/token-accounts/{address}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/solana/token-accounts/{address}", options);
  }

  getApiV1SolanaTransactionsByAddressRaw(
    options: PublicRouteCallOptions<"GET /api/v1/solana/transactions/{address}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/solana/transactions/{address}", options);
  }

  getApiV1StewardTenantsCredentialsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/steward/tenants/credentials"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/steward/tenants/credentials", options);
  }

  getApiV1SubscriptionsCancelByCommandIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/subscriptions/cancel/{commandId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/subscriptions/cancel/{commandId}",
      options,
    );
  }

  getApiV1SubscriptionsCancelUndoByCommandIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/subscriptions/cancel/undo/{commandId}">,
  ): Promise<Response> {
    return this.callRaw(
      "GET /api/v1/subscriptions/cancel/undo/{commandId}",
      options,
    );
  }

  getApiV1SubscriptionsCommandsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/subscriptions/commands"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/subscriptions/commands", options);
  }

  getApiV1SubscriptionsPlansRaw(
    options: PublicRouteCallOptions<"GET /api/v1/subscriptions/plans"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/subscriptions/plans", options);
  }

  getApiV1TelegramChatsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/telegram/chats"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/telegram/chats", options);
  }

  getApiV1TelegramScanChatsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/telegram/scan-chats"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/telegram/scan-chats", options);
  }

  getApiV1TelegramStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/telegram/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/telegram/status", options);
  }

  getApiV1TwilioStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/twilio/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/twilio/status", options);
  }

  getApiV1TwilioVoiceCallsByCallSidRaw(
    options: PublicRouteCallOptions<"GET /api/v1/twilio/voice/calls/{callSid}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/twilio/voice/calls/{callSid}", options);
  }

  getApiV1TwilioVoiceMediaRaw(
    options: PublicRouteCallOptions<"GET /api/v1/twilio/voice/media"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/twilio/voice/media", options);
  }

  getApiV1TwitterCallbackRaw(
    options: PublicRouteCallOptions<"GET /api/v1/twitter/callback"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/twitter/callback", options);
  }

  getApiV1TwitterStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/twitter/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/twitter/status", options);
  }

  getApiV1TwitterTokenRaw(
    options: PublicRouteCallOptions<"GET /api/v1/twitter/token"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/twitter/token", options);
  }

  getApiV1UserRaw(
    options: PublicRouteCallOptions<"GET /api/v1/user"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/user", options);
  }

  getApiV1UserWalletsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/user/wallets"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/user/wallets", options);
  }

  getApiV1VideoFeaturedRaw(
    options: PublicRouteCallOptions<"GET /api/v1/video/featured"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/video/featured", options);
  }

  getApiV1VideoUsageRaw(
    options: PublicRouteCallOptions<"GET /api/v1/video/usage"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/video/usage", options);
  }

  getApiV1VoiceModelsCatalogRaw(
    options: PublicRouteCallOptions<"GET /api/v1/voice-models/catalog"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/voice-models/catalog", options);
  }

  getApiV1VoiceByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/voice/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/voice/{id}", options);
  }

  getApiV1VoiceJobsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/voice/jobs"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/voice/jobs", options);
  }

  getApiV1VoiceListRaw(
    options: PublicRouteCallOptions<"GET /api/v1/voice/list"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/voice/list", options);
  }

  getApiV1VoiceSessionWsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/voice/session/ws"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/voice/session/ws", options);
  }

  getApiV1WhatsappStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/whatsapp/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/whatsapp/status", options);
  }

  getApiV1XDmsDigestRaw(
    options: PublicRouteCallOptions<"GET /api/v1/x/dms/digest"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/x/dms/digest", options);
  }

  getApiV1XFeedRaw(
    options: PublicRouteCallOptions<"GET /api/v1/x/feed"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/x/feed", options);
  }

  getApiV1XStatusRaw(
    options: PublicRouteCallOptions<"GET /api/v1/x/status"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/x/status", options);
  }

  getApiV1X402Raw(
    options: PublicRouteCallOptions<"GET /api/v1/x402"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/x402", options);
  }

  getApiV1X402RequestsRaw(
    options: PublicRouteCallOptions<"GET /api/v1/x402/requests"> = {},
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/x402/requests", options);
  }

  getApiV1X402RequestsByIdRaw(
    options: PublicRouteCallOptions<"GET /api/v1/x402/requests/{id}">,
  ): Promise<Response> {
    return this.callRaw("GET /api/v1/x402/requests/{id}", options);
  }

  headApiV1ApisStorageObjectsRaw(
    options: PublicRouteCallOptions<"HEAD /api/v1/apis/storage/objects/_">,
  ): Promise<Response> {
    return this.callRaw("HEAD /api/v1/apis/storage/objects/_", options);
  }

  patchApiElevenlabsVoicesByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/elevenlabs/voices/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/elevenlabs/voices/{id}", options);
  }

  patchApiV1AdvertisingAccountsByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/advertising/accounts/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/advertising/accounts/{id}", options);
  }

  patchApiV1AdvertisingAudienceSegmentsByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/advertising/audience-segments/{id}">,
  ): Promise<Response> {
    return this.callRaw(
      "PATCH /api/v1/advertising/audience-segments/{id}",
      options,
    );
  }

  patchApiV1AdvertisingCampaignsByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/advertising/campaigns/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/advertising/campaigns/{id}", options);
  }

  patchApiV1AdvertisingCreativesByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/advertising/creatives/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/advertising/creatives/{id}", options);
  }

  patchApiV1ApiKeysByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/api-keys/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/api-keys/{id}", options);
  }

  patchApiV1AppsByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/apps/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/apps/{id}", options);
  }

  patchApiV1AppsByIdDomainsByDomainDnsByRecordIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/apps/{id}/domains/{domain}/dns/{recordId}">,
  ): Promise<Response> {
    return this.callRaw(
      "PATCH /api/v1/apps/{id}/domains/{domain}/dns/{recordId}",
      options,
    );
  }

  patchApiV1ConnectionsByPlatformRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/connections/{platform}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/connections/{platform}", options);
  }

  patchApiV1ContainersByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/containers/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/containers/{id}", options);
  }

  patchApiV1DiscordConnectionsByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/discord/connections/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/discord/connections/{id}", options);
  }

  patchApiV1ElizaAgentsByAgentIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/agents/{agentId}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/eliza/agents/{agentId}", options);
  }

  patchApiV1ElizaAgentsByAgentIdApiByPathRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<Response> {
    return this.callRaw(
      "PATCH /api/v1/eliza/agents/{agentId}/api/{path}",
      options,
    );
  }

  patchApiV1ElizaAgentsByAgentIdApiConversationsByConversationIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}">,
  ): Promise<Response> {
    return this.callRaw(
      "PATCH /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}",
      options,
    );
  }

  patchApiV1ElizaAgentsByAgentIdEnvironmentRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/agents/{agentId}/environment">,
  ): Promise<Response> {
    return this.callRaw(
      "PATCH /api/v1/eliza/agents/{agentId}/environment",
      options,
    );
  }

  patchApiV1ElizaGoogleCalendarEventsByEventIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/eliza/google/calendar/events/{eventId}">,
  ): Promise<Response> {
    return this.callRaw(
      "PATCH /api/v1/eliza/google/calendar/events/{eventId}",
      options,
    );
  }

  patchApiV1MarketingInventoryBySlotIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/marketing/inventory/{slotId}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/marketing/inventory/{slotId}", options);
  }

  patchApiV1MarketingPrByReleaseIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/marketing/pr/{releaseId}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/marketing/pr/{releaseId}", options);
  }

  patchApiV1ProxyBirdeyeByPathRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/proxy/birdeye/{path}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/proxy/birdeye/{path}", options);
  }

  patchApiV1RemoteSessionsByIdActivateRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/remote/sessions/{id}/activate">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/remote/sessions/{id}/activate", options);
  }

  patchApiV1UserRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/user"> = {},
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/user", options);
  }

  patchApiV1UserEmailRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/user/email"> = {},
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/user/email", options);
  }

  patchApiV1VoiceByIdRaw(
    options: PublicRouteCallOptions<"PATCH /api/v1/voice/{id}">,
  ): Promise<Response> {
    return this.callRaw("PATCH /api/v1/voice/{id}", options);
  }

  postApiElevenlabsSttRaw(
    options: PublicRouteCallOptions<"POST /api/elevenlabs/stt"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/elevenlabs/stt", options);
  }

  postApiElevenlabsTtsRaw(
    options: PublicRouteCallOptions<"POST /api/elevenlabs/tts"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/elevenlabs/tts", options);
  }

  postApiV1AdvertisingAccountsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/accounts"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/advertising/accounts", options);
  }

  postApiV1AdvertisingAccountsByIdRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/accounts/{id}">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/advertising/accounts/{id}", options);
  }

  postApiV1AdvertisingAccountsByIdMediaRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/accounts/{id}/media">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/advertising/accounts/{id}/media",
      options,
    );
  }

  postApiV1AdvertisingAccountsDiscoverRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/accounts/discover"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/advertising/accounts/discover", options);
  }

  postApiV1AdvertisingAudienceSegmentsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/audience-segments"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/advertising/audience-segments", options);
  }

  postApiV1AdvertisingAudienceSegmentsByIdApplyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/audience-segments/{id}/apply">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/advertising/audience-segments/{id}/apply",
      options,
    );
  }

  postApiV1AdvertisingCampaignsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/advertising/campaigns", options);
  }

  postApiV1AdvertisingCampaignsByIdAttributionRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/attribution">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/advertising/campaigns/{id}/attribution",
      options,
    );
  }

  postApiV1AdvertisingCampaignsByIdCreativesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/creatives">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/advertising/campaigns/{id}/creatives",
      options,
    );
  }

  postApiV1AdvertisingCampaignsByIdDuplicateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/duplicate">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/advertising/campaigns/{id}/duplicate",
      options,
    );
  }

  postApiV1AdvertisingCampaignsByIdPauseRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/pause">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/advertising/campaigns/{id}/pause",
      options,
    );
  }

  postApiV1AdvertisingCampaignsByIdReportShareRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/report/share">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/advertising/campaigns/{id}/report/share",
      options,
    );
  }

  postApiV1AdvertisingCampaignsByIdStartRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/campaigns/{id}/start">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/advertising/campaigns/{id}/start",
      options,
    );
  }

  postApiV1AdvertisingConversionsTrackRaw(
    options: PublicRouteCallOptions<"POST /api/v1/advertising/conversions/track"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/advertising/conversions/track", options);
  }

  postApiV1AffiliatesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/affiliates"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/affiliates", options);
  }

  postApiV1AffiliatesLinkRaw(
    options: PublicRouteCallOptions<"POST /api/v1/affiliates/link"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/affiliates/link", options);
  }

  postApiV1AgentTokensRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agent-tokens"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/agent-tokens", options);
  }

  postApiV1AgentsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agents"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/agents", options);
  }

  postApiV1AgentsByAgentIdMessageRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/message">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/agents/{agentId}/message", options);
  }

  postApiV1AgentsByAgentIdPublishRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/publish">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/agents/{agentId}/publish", options);
  }

  postApiV1AgentsByAgentIdRestartRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/restart">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/agents/{agentId}/restart", options);
  }

  postApiV1AgentsByAgentIdResumeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/resume">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/agents/{agentId}/resume", options);
  }

  postApiV1AgentsByAgentIdSuspendRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/suspend">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/agents/{agentId}/suspend", options);
  }

  postApiV1AgentsByAgentIdWorkflowsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/workflows">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/agents/{agentId}/workflows", options);
  }

  postApiV1AgentsByAgentIdWorkflowsByWorkflowIdRunRaw(
    options: PublicRouteCallOptions<"POST /api/v1/agents/{agentId}/workflows/{workflowId}/run">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/agents/{agentId}/workflows/{workflowId}/run",
      options,
    );
  }

  postApiV1ApiKeysRaw(
    options: PublicRouteCallOptions<"POST /api/v1/api-keys"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/api-keys", options);
  }

  postApiV1ApiKeysByIdRegenerateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/api-keys/{id}/regenerate">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/api-keys/{id}/regenerate", options);
  }

  postApiV1ApisStoragePresignRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apis/storage/presign">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apis/storage/presign", options);
  }

  postApiV1ApisTunnelsTailscaleAuthKeyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apis/tunnels/tailscale/auth-key"> = {},
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/apis/tunnels/tailscale/auth-key",
      options,
    );
  }

  postApiV1AppAuthConnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/app-auth/connect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/app-auth/connect", options);
  }

  postApiV1AppAuthMobileAckRaw(
    options: PublicRouteCallOptions<"POST /api/v1/app-auth/mobile/ack"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/app-auth/mobile/ack", options);
  }

  postApiV1AppAuthMobileTokenRaw(
    options: PublicRouteCallOptions<"POST /api/v1/app-auth/mobile/token"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/app-auth/mobile/token", options);
  }

  postApiV1AppCreditsCheckoutRaw(
    options: PublicRouteCallOptions<"POST /api/v1/app-credits/checkout"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/app-credits/checkout", options);
  }

  postApiV1AppAgentsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/app/agents"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/app/agents", options);
  }

  postApiV1ApprovalRequestsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/approval-requests"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/approval-requests", options);
  }

  postApiV1ApprovalRequestsByIdApproveRaw(
    options: PublicRouteCallOptions<"POST /api/v1/approval-requests/{id}/approve">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/approval-requests/{id}/approve", options);
  }

  postApiV1ApprovalRequestsByIdCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/approval-requests/{id}/cancel">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/approval-requests/{id}/cancel", options);
  }

  postApiV1ApprovalRequestsByIdDenyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/approval-requests/{id}/deny">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/approval-requests/{id}/deny", options);
  }

  postApiV1AppsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps", options);
  }

  postApiV1AppsByIdBillingRegistrationRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/billing/registration">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/billing/registration", options);
  }

  postApiV1AppsByIdChargesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/charges">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/charges", options);
  }

  postApiV1AppsByIdChargesByChargeIdCheckoutRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/charges/{chargeId}/checkout">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/apps/{id}/charges/{chargeId}/checkout",
      options,
    );
  }

  postApiV1AppsByIdChatRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/chat">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/chat", options);
  }

  postApiV1AppsByIdDeployRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/deploy">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/deploy", options);
  }

  postApiV1AppsByIdDiscordAutomationRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/discord-automation">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/discord-automation", options);
  }

  postApiV1AppsByIdDiscordAutomationPostRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/discord-automation/post">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/apps/{id}/discord-automation/post",
      options,
    );
  }

  postApiV1AppsByIdDomainsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/domains", options);
  }

  postApiV1AppsByIdDomainsByDomainDnsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/{domain}/dns">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/domains/{domain}/dns", options);
  }

  postApiV1AppsByIdDomainsBuyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/buy">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/domains/buy", options);
  }

  postApiV1AppsByIdDomainsCheckRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/check">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/domains/check", options);
  }

  postApiV1AppsByIdDomainsStatusRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/status">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/domains/status", options);
  }

  postApiV1AppsByIdDomainsSyncRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/sync">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/domains/sync", options);
  }

  postApiV1AppsByIdDomainsVerifyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/domains/verify">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/domains/verify", options);
  }

  postApiV1AppsByIdEarningsWithdrawRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/earnings/withdraw">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/earnings/withdraw", options);
  }

  postApiV1AppsByIdFrontendRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/frontend">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/frontend", options);
  }

  postApiV1AppsByIdFrontendByDeploymentIdActivateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/frontend/{deploymentId}/activate">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/apps/{id}/frontend/{deploymentId}/activate",
      options,
    );
  }

  postApiV1AppsByIdGenerateImageRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/generate-image">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/generate-image", options);
  }

  postApiV1AppsByIdPromoteRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/promote">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/promote", options);
  }

  postApiV1AppsByIdPromoteAssetsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/promote/assets">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/promote/assets", options);
  }

  postApiV1AppsByIdPromotePreviewRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/promote/preview">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/promote/preview", options);
  }

  postApiV1AppsByIdRegenerateApiKeyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/regenerate-api-key">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/regenerate-api-key", options);
  }

  postApiV1AppsByIdReviewRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/review">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/review", options);
  }

  postApiV1AppsByIdTelegramAutomationRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/telegram-automation">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/telegram-automation", options);
  }

  postApiV1AppsByIdTelegramAutomationPostRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/telegram-automation/post">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/apps/{id}/telegram-automation/post",
      options,
    );
  }

  postApiV1AppsByIdTwitterAutomationRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/twitter-automation">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/{id}/twitter-automation", options);
  }

  postApiV1AppsByIdTwitterAutomationPostRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/{id}/twitter-automation/post">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/apps/{id}/twitter-automation/post",
      options,
    );
  }

  postApiV1AppsBackupRestoreRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/backup/restore"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/backup/restore", options);
  }

  postApiV1AppsCheckNameRaw(
    options: PublicRouteCallOptions<"POST /api/v1/apps/check-name"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/apps/check-name", options);
  }

  postApiV1BallotsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/ballots"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/ballots", options);
  }

  postApiV1BallotsByIdCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/ballots/{id}/cancel">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/ballots/{id}/cancel", options);
  }

  postApiV1BallotsByIdDistributeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/ballots/{id}/distribute">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/ballots/{id}/distribute", options);
  }

  postApiV1BallotsByIdTallyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/ballots/{id}/tally">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/ballots/{id}/tally", options);
  }

  postApiV1BallotsByIdVoteRaw(
    options: PublicRouteCallOptions<"POST /api/v1/ballots/{id}/vote">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/ballots/{id}/vote", options);
  }

  postApiV1BillingResourcesByIdCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/billing/resources/{id}/cancel">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/billing/resources/{id}/cancel", options);
  }

  postApiV1BlooioConnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/blooio/connect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/blooio/connect", options);
  }

  postApiV1BlooioDisconnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/blooio/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/blooio/disconnect", options);
  }

  postApiV1BrowserSessionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/browser/sessions"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/browser/sessions", options);
  }

  postApiV1BrowserSessionsByIdCommandRaw(
    options: PublicRouteCallOptions<"POST /api/v1/browser/sessions/{id}/command">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/browser/sessions/{id}/command", options);
  }

  postApiV1BrowserSessionsByIdNavigateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/browser/sessions/{id}/navigate">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/browser/sessions/{id}/navigate", options);
  }

  postApiV1ChatRaw(
    options: PublicRouteCallOptions<"POST /api/v1/chat"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/chat", options);
  }

  postApiV1ChatCompletionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/chat/completions"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/chat/completions", options);
  }

  postApiV1CodingContainersRaw(
    options: PublicRouteCallOptions<"POST /api/v1/coding-containers"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/coding-containers", options);
  }

  postApiV1CodingContainersByContainerIdSyncRaw(
    options: PublicRouteCallOptions<"POST /api/v1/coding-containers/{containerId}/sync">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/coding-containers/{containerId}/sync",
      options,
    );
  }

  postApiV1CodingContainersPromotionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/coding-containers/promotions"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/coding-containers/promotions", options);
  }

  postApiV1ConnectionsByIdBrokerRaw(
    options: PublicRouteCallOptions<"POST /api/v1/connections/{id}/broker">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/connections/{id}/broker", options);
  }

  postApiV1ConnectionsByIdRefreshRaw(
    options: PublicRouteCallOptions<"POST /api/v1/connections/{id}/refresh">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/connections/{id}/refresh", options);
  }

  postApiV1ConnectionsByPlatformRaw(
    options: PublicRouteCallOptions<"POST /api/v1/connections/{platform}">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/connections/{platform}", options);
  }

  postApiV1ContainersRaw(
    options: PublicRouteCallOptions<"POST /api/v1/containers"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/containers", options);
  }

  postApiV1CreditsCheckoutRaw(
    options: PublicRouteCallOptions<"POST /api/v1/credits/checkout"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/credits/checkout", options);
  }

  postApiV1DeviceBusDevicesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/device-bus/devices"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/device-bus/devices", options);
  }

  postApiV1DeviceBusIntentsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/device-bus/intents"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/device-bus/intents", options);
  }

  postApiV1DiscordChannelsRefreshRaw(
    options: PublicRouteCallOptions<"POST /api/v1/discord/channels/refresh"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/discord/channels/refresh", options);
  }

  postApiV1DiscordConnectionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/discord/connections"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/discord/connections", options);
  }

  postApiV1DiscordDisconnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/discord/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/discord/disconnect", options);
  }

  postApiV1DocumentsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/documents"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/documents", options);
  }

  postApiV1DocumentsPreUploadRaw(
    options: PublicRouteCallOptions<"POST /api/v1/documents/pre-upload"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/documents/pre-upload", options);
  }

  postApiV1DocumentsQueryRaw(
    options: PublicRouteCallOptions<"POST /api/v1/documents/query"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/documents/query", options);
  }

  postApiV1DocumentsSubmitRaw(
    options: PublicRouteCallOptions<"POST /api/v1/documents/submit"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/documents/submit", options);
  }

  postApiV1DocumentsUploadFileRaw(
    options: PublicRouteCallOptions<"POST /api/v1/documents/upload-file"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/documents/upload-file", options);
  }

  postApiV1DomainsSearchRaw(
    options: PublicRouteCallOptions<"POST /api/v1/domains/search"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/domains/search", options);
  }

  postApiV1EarningsPayoutStripeConnectOnboardRaw(
    options: PublicRouteCallOptions<"POST /api/v1/earnings/payout/stripe-connect/onboard"> = {},
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/earnings/payout/stripe-connect/onboard",
      options,
    );
  }

  postApiV1EarningsPayoutStripeConnectTransferRaw(
    options: PublicRouteCallOptions<"POST /api/v1/earnings/payout/stripe-connect/transfer"> = {},
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/earnings/payout/stripe-connect/transfer",
      options,
    );
  }

  postApiV1ElizaAgentsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents", options);
  }

  postApiV1ElizaAgentsByAgentIdApiByPathRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/api/{path}",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdApiConversationsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/conversations">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/api/conversations",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdApiConversationsByConversationIdMessagesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdApiConversationsByConversationIdMessagesStreamRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages/stream">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/api/conversations/{conversationId}/messages/stream",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdApiIdentityRegisterRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/identity/register">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/api/identity/register",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdApiWalletByPathRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/api/wallet/{path}">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/api/wallet/{path}",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdBridgeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/bridge">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/bridge", options);
  }

  postApiV1ElizaAgentsByAgentIdDiscordOauthRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/discord/oauth">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/discord/oauth",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdDowngradeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/downgrade">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/downgrade",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdGithubDeviceCodeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/github/device-code">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/github/device-code",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdGithubLinkRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/github/link">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/github/link",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdGithubOauthRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/github/oauth">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/github/oauth",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdLifeopsScheduleObservationsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/lifeops/schedule/observations">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/lifeops/schedule/observations",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdPairingTokenRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/pairing-token">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/pairing-token",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdProvisionRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/provision">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/provision",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdRestoreRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/restore">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/restore", options);
  }

  postApiV1ElizaAgentsByAgentIdResumeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/resume">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/resume", options);
  }

  postApiV1ElizaAgentsByAgentIdSharedRemindersByTaskIdDeliverRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/shared-reminders/{taskId}/deliver">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/shared-reminders/{taskId}/deliver",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdSleepRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/sleep">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/sleep", options);
  }

  postApiV1ElizaAgentsByAgentIdSnapshotRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/snapshot">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/snapshot",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdStreamRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/stream">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/stream", options);
  }

  postApiV1ElizaAgentsByAgentIdSuspendRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/suspend">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/suspend", options);
  }

  postApiV1ElizaAgentsByAgentIdUpgradeTierRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/upgrade-tier">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/upgrade-tier",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdUpgradeTierAdoptExistingRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/upgrade-tier/adopt-existing",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdUpgradeTierCutoverRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/upgrade-tier/cutover">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/agents/{agentId}/upgrade-tier/cutover",
      options,
    );
  }

  postApiV1ElizaAgentsByAgentIdWakeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/wake">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/wake", options);
  }

  postApiV1ElizaAgentsByAgentIdWriteRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/agents/{agentId}/write">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/agents/{agentId}/write", options);
  }

  postApiV1ElizaDiscordGatewayAgentRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/discord/gateway-agent"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/discord/gateway-agent", options);
  }

  postApiV1ElizaGatewayRelaySessionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/gateway-relay/sessions"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/gateway-relay/sessions", options);
  }

  postApiV1ElizaGatewayRelaySessionsBySessionIdResponsesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/gateway-relay/sessions/{sessionId}/responses">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/gateway-relay/sessions/{sessionId}/responses",
      options,
    );
  }

  postApiV1ElizaGoogleCalendarEventsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/calendar/events"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/google/calendar/events", options);
  }

  postApiV1ElizaGoogleConnectInitiateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/connect/initiate"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/google/connect/initiate", options);
  }

  postApiV1ElizaGoogleDisconnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/google/disconnect", options);
  }

  postApiV1ElizaGoogleGmailMessageSendRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/gmail/message-send"> = {},
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/eliza/google/gmail/message-send",
      options,
    );
  }

  postApiV1ElizaGoogleGmailReplySendRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/google/gmail/reply-send"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/google/gmail/reply-send", options);
  }

  postApiV1ElizaPaypalAuthorizeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/paypal/authorize"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/paypal/authorize", options);
  }

  postApiV1ElizaPaypalCallbackRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/paypal/callback"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/paypal/callback", options);
  }

  postApiV1ElizaPaypalRefreshRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/paypal/refresh"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/paypal/refresh", options);
  }

  postApiV1ElizaPaypalTransactionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/paypal/transactions"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/paypal/transactions", options);
  }

  postApiV1ElizaPlaidExchangeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/exchange"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/plaid/exchange", options);
  }

  postApiV1ElizaPlaidItemConnectionRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/item-connection"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/plaid/item-connection", options);
  }

  postApiV1ElizaPlaidItemStatusRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/item-status"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/plaid/item-status", options);
  }

  postApiV1ElizaPlaidLinkTokenRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/link-token"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/plaid/link-token", options);
  }

  postApiV1ElizaPlaidRevokeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/revoke"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/plaid/revoke", options);
  }

  postApiV1ElizaPlaidSyncRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/sync"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/plaid/sync", options);
  }

  postApiV1ElizaPlaidVerificationKeyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/eliza/plaid/verification-key"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/eliza/plaid/verification-key", options);
  }

  postApiV1EmbeddingsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/embeddings"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/embeddings", options);
  }

  postApiV1ExtractRaw(
    options: PublicRouteCallOptions<"POST /api/v1/extract"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/extract", options);
  }

  postApiV1FilesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/files"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/files", options);
  }

  postApiV1GenerateImageRaw(
    options: PublicRouteCallOptions<"POST /api/v1/generate-image"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/generate-image", options);
  }

  postApiV1GenerateMusicRaw(
    options: PublicRouteCallOptions<"POST /api/v1/generate-music"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/generate-music", options);
  }

  postApiV1GeneratePromptsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/generate-prompts"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/generate-prompts", options);
  }

  postApiV1GenerateSfxRaw(
    options: PublicRouteCallOptions<"POST /api/v1/generate-sfx"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/generate-sfx", options);
  }

  postApiV1GenerateVideoRaw(
    options: PublicRouteCallOptions<"POST /api/v1/generate-video"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/generate-video", options);
  }

  postApiV1MarketingInfluencersRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/marketing/influencers", options);
  }

  postApiV1MarketingInfluencersBookingsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/marketing/influencers/bookings", options);
  }

  postApiV1MarketingInfluencersBookingsByBookingIdAcceptRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/accept">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/accept",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdApproveRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/approve">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/approve",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/cancel">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/cancel",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdDeliverRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/deliver">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/deliver",
      options,
    );
  }

  postApiV1MarketingInfluencersBookingsByBookingIdRejectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/influencers/bookings/{bookingId}/reject">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/marketing/influencers/bookings/{bookingId}/reject",
      options,
    );
  }

  postApiV1MarketingInventoryRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/inventory"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/marketing/inventory", options);
  }

  postApiV1MarketingInventoryClickRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/inventory/click"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/marketing/inventory/click", options);
  }

  postApiV1MarketingPrRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/pr"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/marketing/pr", options);
  }

  postApiV1MarketingPrByReleaseIdCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/pr/{releaseId}/cancel">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/marketing/pr/{releaseId}/cancel",
      options,
    );
  }

  postApiV1MarketingPrByReleaseIdSubmitRaw(
    options: PublicRouteCallOptions<"POST /api/v1/marketing/pr/{releaseId}/submit">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/marketing/pr/{releaseId}/submit",
      options,
    );
  }

  postApiV1McpsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/mcps"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/mcps", options);
  }

  postApiV1McpsByMcpIdPublishRaw(
    options: PublicRouteCallOptions<"POST /api/v1/mcps/{mcpId}/publish">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/mcps/{mcpId}/publish", options);
  }

  postApiV1MeAccountDeletionRaw(
    options: PublicRouteCallOptions<"POST /api/v1/me/account-deletion"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/me/account-deletion", options);
  }

  postApiV1MessagesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/messages"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/messages", options);
  }

  postApiV1ModelsStatusRaw(
    options: PublicRouteCallOptions<"POST /api/v1/models/status"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/models/status", options);
  }

  postApiV1OauthIntentsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/oauth-intents"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/oauth-intents", options);
  }

  postApiV1OauthIntentsByIdCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/oauth-intents/{id}/cancel">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/oauth-intents/{id}/cancel", options);
  }

  postApiV1OauthByPlatformInitiateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/oauth/{platform}/initiate">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/oauth/{platform}/initiate", options);
  }

  postApiV1OauthCallbackByProviderRaw(
    options: PublicRouteCallOptions<"POST /api/v1/oauth/callback/{provider}">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/oauth/callback/{provider}", options);
  }

  postApiV1OauthConnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/oauth/connect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/oauth/connect", options);
  }

  postApiV1OauthInitiateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/oauth/initiate"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/oauth/initiate", options);
  }

  postApiV1OutreachrRaw(
    options: PublicRouteCallOptions<"POST /api/v1/outreachr"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/outreachr", options);
  }

  postApiV1PaymentRequestsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/payment-requests"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/payment-requests", options);
  }

  postApiV1PaymentRequestsByIdCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/payment-requests/{id}/cancel">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/payment-requests/{id}/cancel", options);
  }

  postApiV1PaymentRequestsByIdExpireRaw(
    options: PublicRouteCallOptions<"POST /api/v1/payment-requests/{id}/expire">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/payment-requests/{id}/expire", options);
  }

  postApiV1PiiScrubJobsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/pii-scrub/jobs"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/pii-scrub/jobs", options);
  }

  postApiV1ProxyBirdeyeByPathRaw(
    options: PublicRouteCallOptions<"POST /api/v1/proxy/birdeye/{path}">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/proxy/birdeye/{path}", options);
  }

  postApiV1ProxyEvmRpcByChainRaw(
    options: PublicRouteCallOptions<"POST /api/v1/proxy/evm-rpc/{chain}">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/proxy/evm-rpc/{chain}", options);
  }

  postApiV1ProxySolanaRpcRaw(
    options: PublicRouteCallOptions<"POST /api/v1/proxy/solana-rpc"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/proxy/solana-rpc", options);
  }

  postApiV1RedemptionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/redemptions"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/redemptions", options);
  }

  postApiV1ReferralsApplyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/referrals/apply"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/referrals/apply", options);
  }

  postApiV1RemoteHostsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/hosts"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/remote/hosts", options);
  }

  postApiV1RemoteHostsByIdManagedNetworkActivateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/hosts/{id}/managed-network/activate">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/remote/hosts/{id}/managed-network/activate",
      options,
    );
  }

  postApiV1RemoteHostsByIdRevokeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/hosts/{id}/revoke">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/remote/hosts/{id}/revoke", options);
  }

  postApiV1RemotePairRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/pair"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/remote/pair", options);
  }

  postApiV1RemoteSessionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/remote/sessions", options);
  }

  postApiV1RemoteSessionsByIdActivateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/activate">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/remote/sessions/{id}/activate", options);
  }

  postApiV1RemoteSessionsByIdCommandsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/commands">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/remote/sessions/{id}/commands", options);
  }

  postApiV1RemoteSessionsByIdCommandsByCommandIdCompleteRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/commands/{commandId}/complete">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/remote/sessions/{id}/commands/{commandId}/complete",
      options,
    );
  }

  postApiV1RemoteSessionsByIdCommandsByCommandIdStartRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/commands/{commandId}/start">,
  ): Promise<Response> {
    return this.callRaw(
      "POST /api/v1/remote/sessions/{id}/commands/{commandId}/start",
      options,
    );
  }

  postApiV1RemoteSessionsByIdRevokeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/{id}/revoke">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/remote/sessions/{id}/revoke", options);
  }

  postApiV1RemoteSessionsActivateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/remote/sessions/activate"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/remote/sessions/activate", options);
  }

  postApiV1ReportsBugRaw(
    options: PublicRouteCallOptions<"POST /api/v1/reports/bug"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/reports/bug", options);
  }

  postApiV1ResponsesRaw(
    options: PublicRouteCallOptions<"POST /api/v1/responses"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/responses", options);
  }

  postApiV1RpcByChainRaw(
    options: PublicRouteCallOptions<"POST /api/v1/rpc/{chain}">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/rpc/{chain}", options);
  }

  postApiV1SearchRaw(
    options: PublicRouteCallOptions<"POST /api/v1/search"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/search", options);
  }

  postApiV1SecurityAuditRaw(
    options: PublicRouteCallOptions<"POST /api/v1/security/audit"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/security/audit", options);
  }

  postApiV1SensitiveRequestsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/sensitive-requests"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/sensitive-requests", options);
  }

  postApiV1SensitiveRequestsByIdCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/sensitive-requests/{id}/cancel">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/sensitive-requests/{id}/cancel", options);
  }

  postApiV1SensitiveRequestsByIdExpireRaw(
    options: PublicRouteCallOptions<"POST /api/v1/sensitive-requests/{id}/expire">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/sensitive-requests/{id}/expire", options);
  }

  postApiV1SensitiveRequestsByIdSubmitRaw(
    options: PublicRouteCallOptions<"POST /api/v1/sensitive-requests/{id}/submit">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/sensitive-requests/{id}/submit", options);
  }

  postApiV1SolanaRpcRaw(
    options: PublicRouteCallOptions<"POST /api/v1/solana/rpc"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/solana/rpc", options);
  }

  postApiV1StewardTenantsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/steward/tenants"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/steward/tenants", options);
  }

  postApiV1StripeCheckoutRaw(
    options: PublicRouteCallOptions<"POST /api/v1/stripe/checkout"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/stripe/checkout", options);
  }

  postApiV1SubscriptionsCancelRaw(
    options: PublicRouteCallOptions<"POST /api/v1/subscriptions/cancel"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/subscriptions/cancel", options);
  }

  postApiV1SubscriptionsCancelUndoRaw(
    options: PublicRouteCallOptions<"POST /api/v1/subscriptions/cancel/undo"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/subscriptions/cancel/undo", options);
  }

  postApiV1TelegramConnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/telegram/connect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/telegram/connect", options);
  }

  postApiV1TelegramScanChatsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/telegram/scan-chats"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/telegram/scan-chats", options);
  }

  postApiV1Topup10Raw(
    options: PublicRouteCallOptions<"POST /api/v1/topup/10"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/topup/10", options);
  }

  postApiV1Topup100Raw(
    options: PublicRouteCallOptions<"POST /api/v1/topup/100"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/topup/100", options);
  }

  postApiV1Topup50Raw(
    options: PublicRouteCallOptions<"POST /api/v1/topup/50"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/topup/50", options);
  }

  postApiV1TrackPageviewRaw(
    options: PublicRouteCallOptions<"POST /api/v1/track/pageview"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/track/pageview", options);
  }

  postApiV1TwilioConnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/connect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/twilio/connect", options);
  }

  postApiV1TwilioDisconnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/twilio/disconnect", options);
  }

  postApiV1TwilioVoiceCallsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/voice/calls"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/twilio/voice/calls", options);
  }

  postApiV1TwilioVoiceInboundRaw(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/voice/inbound"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/twilio/voice/inbound", options);
  }

  postApiV1TwilioVoiceStatusRaw(
    options: PublicRouteCallOptions<"POST /api/v1/twilio/voice/status"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/twilio/voice/status", options);
  }

  postApiV1TwitterConnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/twitter/connect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/twitter/connect", options);
  }

  postApiV1TwitterPersonalMessageRaw(
    options: PublicRouteCallOptions<"POST /api/v1/twitter/personal-message"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/twitter/personal-message", options);
  }

  postApiV1UserAvatarRaw(
    options: PublicRouteCallOptions<"POST /api/v1/user/avatar"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/user/avatar", options);
  }

  postApiV1UserWalletsProvisionRaw(
    options: PublicRouteCallOptions<"POST /api/v1/user/wallets/provision"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/user/wallets/provision", options);
  }

  postApiV1UserWalletsRpcRaw(
    options: PublicRouteCallOptions<"POST /api/v1/user/wallets/rpc"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/user/wallets/rpc", options);
  }

  postApiV1VoiceCloneRaw(
    options: PublicRouteCallOptions<"POST /api/v1/voice/clone"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/voice/clone", options);
  }

  postApiV1VoiceSessionRaw(
    options: PublicRouteCallOptions<"POST /api/v1/voice/session"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/voice/session", options);
  }

  postApiV1VoiceSessionByIdRevokeRaw(
    options: PublicRouteCallOptions<"POST /api/v1/voice/session/{id}/revoke">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/voice/session/{id}/revoke", options);
  }

  postApiV1VoiceSessionConsentRaw(
    options: PublicRouteCallOptions<"POST /api/v1/voice/session/consent"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/voice/session/consent", options);
  }

  postApiV1VoiceSttRaw(
    options: PublicRouteCallOptions<"POST /api/v1/voice/stt"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/voice/stt", options);
  }

  postApiV1VoiceTtsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/voice/tts"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/voice/tts", options);
  }

  postApiV1WebPushSubscriptionsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/web-push/subscriptions"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/web-push/subscriptions", options);
  }

  postApiV1WhatsappConnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/whatsapp/connect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/whatsapp/connect", options);
  }

  postApiV1WhatsappDisconnectRaw(
    options: PublicRouteCallOptions<"POST /api/v1/whatsapp/disconnect"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/whatsapp/disconnect", options);
  }

  postApiV1XDmsConversationsSendRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x/dms/conversations/send"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x/dms/conversations/send", options);
  }

  postApiV1XDmsCurateRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x/dms/curate"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x/dms/curate", options);
  }

  postApiV1XDmsGroupsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x/dms/groups"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x/dms/groups", options);
  }

  postApiV1XDmsSendRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x/dms/send"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x/dms/send", options);
  }

  postApiV1XPostsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x/posts"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x/posts", options);
  }

  postApiV1X402RequestsRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x402/requests"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x402/requests", options);
  }

  postApiV1X402RequestsByIdSettleRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x402/requests/{id}/settle">,
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x402/requests/{id}/settle", options);
  }

  postApiV1X402SettleRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x402/settle"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x402/settle", options);
  }

  postApiV1X402VerifyRaw(
    options: PublicRouteCallOptions<"POST /api/v1/x402/verify"> = {},
  ): Promise<Response> {
    return this.callRaw("POST /api/v1/x402/verify", options);
  }

  putApiV1AdvertisingCampaignsByIdDaypartingRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/advertising/campaigns/{id}/dayparting">,
  ): Promise<Response> {
    return this.callRaw(
      "PUT /api/v1/advertising/campaigns/{id}/dayparting",
      options,
    );
  }

  putApiV1AffiliatesRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/affiliates"> = {},
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/affiliates", options);
  }

  putApiV1AgentsByAgentIdMonetizationRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/agents/{agentId}/monetization">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/agents/{agentId}/monetization", options);
  }

  putApiV1AgentsByAgentIdWorkflowsByWorkflowIdRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/agents/{agentId}/workflows/{workflowId}">,
  ): Promise<Response> {
    return this.callRaw(
      "PUT /api/v1/agents/{agentId}/workflows/{workflowId}",
      options,
    );
  }

  putApiV1ApisStorageObjectsRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/apis/storage/objects/_">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/apis/storage/objects/_", options);
  }

  putApiV1AppsByIdRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/apps/{id}">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/apps/{id}", options);
  }

  putApiV1AppsByIdCharactersRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/apps/{id}/characters">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/apps/{id}/characters", options);
  }

  putApiV1AppsByIdDatabaseRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/apps/{id}/database">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/apps/{id}/database", options);
  }

  putApiV1AppsByIdMonetizationRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/apps/{id}/monetization">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/apps/{id}/monetization", options);
  }

  putApiV1BillingSettingsRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/billing/settings"> = {},
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/billing/settings", options);
  }

  putApiV1ConnectionsByPlatformRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/connections/{platform}">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/connections/{platform}", options);
  }

  putApiV1ElizaAgentsByAgentIdApiByPathRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/eliza/agents/{agentId}/api/{path}">,
  ): Promise<Response> {
    return this.callRaw(
      "PUT /api/v1/eliza/agents/{agentId}/api/{path}",
      options,
    );
  }

  putApiV1ElizaAgentsByAgentIdApiIdentityUriRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/eliza/agents/{agentId}/api/identity/uri">,
  ): Promise<Response> {
    return this.callRaw(
      "PUT /api/v1/eliza/agents/{agentId}/api/identity/uri",
      options,
    );
  }

  putApiV1ElizaAgentsByAgentIdApiWalletByPathRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/eliza/agents/{agentId}/api/wallet/{path}">,
  ): Promise<Response> {
    return this.callRaw(
      "PUT /api/v1/eliza/agents/{agentId}/api/wallet/{path}",
      options,
    );
  }

  putApiV1McpsByMcpIdRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/mcps/{mcpId}">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/mcps/{mcpId}", options);
  }

  putApiV1ProxyBirdeyeByPathRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/proxy/birdeye/{path}">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/proxy/birdeye/{path}", options);
  }

  putApiV1RemoteSessionsByIdActivateRaw(
    options: PublicRouteCallOptions<"PUT /api/v1/remote/sessions/{id}/activate">,
  ): Promise<Response> {
    return this.callRaw("PUT /api/v1/remote/sessions/{id}/activate", options);
  }
}
