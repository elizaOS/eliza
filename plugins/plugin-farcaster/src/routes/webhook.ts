import { Route } from '@elizaos/core';

export const farcasterWebhookRoutes: Route[] = [
  {
    type: 'POST',
    name: 'Farcaster Webhook Handler',
    path: '/webhook',
    handler: async (req: any, res: any, runtime: any) => {
      try {
        const webhookData = req.body;
        const eventType = webhookData.type;

        // Get the Farcaster service from the runtime
        const farcasterService = runtime?.getService?.('farcaster');
        
        if (farcasterService) {
          // Get the agent manager for this runtime
          const agentManager = farcasterService.managers?.get?.(runtime.agentId);
          
          if (agentManager && agentManager.interactions) {
            // Check if we're in webhook mode
            if (agentManager.interactions.mode === 'webhook') {
              console.log("Processing webhook through FarcasterInteractionManager...");
              await agentManager.interactions.processWebhookData(webhookData);
            } else {
              console.warn(`Agent is in ${agentManager.interactions.mode} mode, not webhook mode`);
            }
          } else {
            console.warn(`FarcasterAgentManager not found for agent ${runtime.agentId}`);
          }
        } else {
          console.warn("FarcasterService not found - webhook data logged only");
        }
        
        // Send success response
        res.status(200).json({ 
          success: true, 
          message: 'Webhook processed successfully',
          event_type: eventType,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ 
          success: false, 
          error: 'Internal server error' 
        });
      }
    }
  }
];
