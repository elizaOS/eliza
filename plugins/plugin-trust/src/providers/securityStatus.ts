import { type Provider, type IAgentRuntime, type Memory, type State, logger } from '@elizaos/core';

export const securityStatusProvider: Provider = {
  name: 'securityStatus',
  description: 'Provides current security status and alerts',

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const securityModule = runtime.getService('security-module') as any;

      if (!securityModule) {
        return {
          text: 'Security module not available',
          values: {},
        };
      }

      // Check for recent security incidents
      const recentIncidents = await securityModule.getRecentSecurityIncidents(
        message.roomId,
        24 // Last 24 hours
      );

      // Get current threat level - pass SecurityContext object
      const threatAssessment = await securityModule.assessThreatLevel({
        roomId: message.roomId,
        entityId: message.entityId,
      });

      // Check if current message has security concerns
      const messageAnalysis = await securityModule.analyzeMessage(
        message.content.text || '',
        message.entityId,
        { roomId: message.roomId }
      );

      // Format security information
      const securityStatus =
        recentIncidents.length === 0
          ? 'No security incidents in the last 24 hours'
          : `${recentIncidents.length} security incident(s) detected in the last 24 hours`;

      const alertLevel =
        threatAssessment.confidence > 0.7
          ? 'HIGH ALERT'
          : threatAssessment.confidence > 0.4
            ? 'ELEVATED'
            : 'NORMAL';

      let statusText = `Security Status: ${alertLevel}. ${securityStatus}.`;

      if (messageAnalysis.detected) {
        statusText += ` ⚠️ Current message flagged: ${messageAnalysis.type}`;
      }

      return {
        text: statusText,
        values: {
          threatLevel: threatAssessment.confidence,
          alertLevel,
          recentIncidentCount: recentIncidents.length,
          hasActiveThreats: threatAssessment.confidence > 0.4,
          currentMessageFlagged: messageAnalysis.detected,
          securityConcern: messageAnalysis.type || 'none',
        },
        data: {
          recentIncidents,
          messageAnalysis,
          threatAssessment,
          recommendations: securityModule.getSecurityRecommendations(threatAssessment.confidence),
        },
      };
    } catch (error) {
      logger.error({ error }, '[SecurityStatusProvider] Error fetching security status:');
      return {
        text: 'Unable to fetch security status',
        values: {},
      };
    }
  },
};
