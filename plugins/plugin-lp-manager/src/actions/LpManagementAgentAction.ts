import { Action, IAgentRuntime } from '@elizaos/core';
import {
  IDexInteractionService,
  IUserLpProfileService,
  IVaultService,
  LpActionParams,
  LpPositionDetails,
  TokenBalance,
  UserLpProfile,
} from '../types.ts';

const formatPositions = (positions: LpPositionDetails[]): string => {
    if (!positions || positions.length === 0) {
        return 'No active LP positions found.';
    }
    let response = "Your LP Positions:\n";
    positions.forEach((pos, index) => {
        const underlying = pos.underlyingTokens.map((t: TokenBalance) => `${t.uiAmount?.toFixed(4) || 'N/A'} ${t.symbol}`).join(' & ');
        response += `\n[${index + 1}] **${pos.poolId}** on **${pos.dex.toUpperCase()}**\n` +
                    `   - **Value**: $${pos.valueUsd?.toFixed(2) || 'N/A'}\n` +
                    `   - **Composition**: ${underlying}\n` +
                    `   - **LP Tokens**: ${pos.lpTokenBalance.uiAmount?.toFixed(6) || 'N/A'} ${pos.lpTokenBalance.symbol}\n`;
    });
    return response;
};

// Helper function to parse intent from natural language
const parseIntentFromMessage = (text: string): LpActionParams | null => {
    const lowerText = text.toLowerCase();
    
    // Onboarding patterns
    if (lowerText.includes('start lp management') || 
        lowerText.includes('set me up') || 
        lowerText.includes('onboard') ||
        lowerText.includes('get started') ||
        lowerText.includes('help me get started')) {
        return { intent: 'onboard_lp', userId: '' };
    }
    
    // Concentrated liquidity patterns
    if (lowerText.includes('concentrated') || 
        lowerText.includes('range') && lowerText.includes('position') ||
        lowerText.includes('price range') ||
        lowerText.includes('narrow range') ||
        lowerText.includes('tight range')) {
        
        if (lowerText.includes('create') || lowerText.includes('open') || lowerText.includes('add')) {
            return { intent: 'create_concentrated_lp', userId: '' };
        }
        if (lowerText.includes('rebalance') || lowerText.includes('adjust') || lowerText.includes('move')) {
            return { intent: 'rebalance_concentrated_lp', userId: '' };
        }
        if (lowerText.includes('show') || lowerText.includes('check') || lowerText.includes('view')) {
            return { intent: 'show_concentrated_lps', userId: '' };
        }
    }
    
    // Deposit patterns
    if (lowerText.includes('add liquidity') || 
        lowerText.includes('deposit') || 
        lowerText.includes('lp all my') ||
        lowerText.includes('lp 100') ||
        lowerText.includes('add') && lowerText.includes('pool')) {
        return { intent: 'deposit_lp', userId: '' };
    }
    
    // Withdrawal patterns
    if (lowerText.includes('withdraw') || 
        lowerText.includes('remove') ||
        lowerText.includes('exit') && lowerText.includes('position')) {
        return { intent: 'withdraw_lp', userId: '' };
    }
    
    // Show positions patterns
    if (lowerText.includes('show') && (lowerText.includes('position') || lowerText.includes('lp')) ||
        lowerText.includes('my lp') ||
        lowerText.includes('check') && lowerText.includes('position')) {
        return { intent: 'show_lps', userId: '' };
    }
    
    // Preferences patterns
    if (lowerText.includes('auto-rebalance') || 
        lowerText.includes('auto rebalance') ||
        lowerText.includes('enable') && lowerText.includes('rebalance') ||
        lowerText.includes('preference') ||
        lowerText.includes('slippage')) {
        return { intent: 'set_lp_preferences', userId: '' };
    }
    
    // Pool discovery patterns
    if (lowerText.includes('pool') && (lowerText.includes('show') || lowerText.includes('find') || lowerText.includes('best'))) {
        return { intent: 'deposit_lp', userId: '' }; // Default to deposit intent for pool discovery
    }
    
    return null;
};

const handleOnboardLp = async (
  runtime: IAgentRuntime,
  userId: string, 
  existingProfile: UserLpProfile | null, 
  config?: Partial<UserLpProfile['autoRebalanceConfig']>
) => {
  const vaultService = runtime.getService<IVaultService>('VaultService');
  const userLpProfileService = runtime.getService<IUserLpProfileService>('UserLpProfileService');

  if (!vaultService || !userLpProfileService) {
    throw new Error('Could not get required services for onboarding.');
  }

  if (existingProfile) {
    return { text: `You are already onboarded. Your vault public key is: ${existingProfile.vaultPublicKey}` };
  }
  const { publicKey, secretKeyEncrypted } = await vaultService.createVault(userId);
  const newProfile = await userLpProfileService.ensureProfile(userId, publicKey, secretKeyEncrypted, config);
  return { 
    content: `Welcome! I've created a new secure vault for you. **Your vault address is: ${newProfile.vaultPublicKey}**. Please send the assets you want me to manage to this address. Auto-rebalancing is currently **${newProfile.autoRebalanceConfig.enabled ? 'ON' : 'OFF'}**.` 
  };
};

export const LpManagementAgentAction: Action = {
  name: 'lp_management',
  description: 'Manages Liquidity Pool (LP) operations including: onboarding for LP management, depositing tokens into pools, withdrawing from pools, showing LP positions, concentrated liquidity positions with custom price ranges, checking APR/yield, setting auto-rebalance preferences, and finding best pools. Use this action when users mention: liquidity, LP, pools, APR, yield, deposit, withdraw, concentrated, price range, narrow range, degenai, ai16z, SOL pairs, or want help getting started with LP management.',
  
  similes: [
    'LP_MANAGEMENT',
    'LIQUIDITY_POOL_MANAGEMENT',
    'LP_MANAGER',
    'MANAGE_LP',
    'MANAGE_LIQUIDITY'
  ],
  
  examples: [] as any[], // TODO: Add proper examples once ActionExample type is clarified

  validate: async (runtime, message, state) => {
    console.info('[LpManagementAgentAction] Validate called with message:', message?.content?.text || 'No text');
    
    // If there's no message content, validation fails
    if (!message?.content?.text) {
      console.info('[LpManagementAgentAction] No message text, returning false');
      return false;
    }
    
    const text = message.content.text.toLowerCase();
    
    // Check for LP-related keywords in the message
    const lpKeywords = [
      'liquidity', 'lp', 'pool', 'dex', 'vault', 'slippage', 
      'apr', 'apy', 'tvl', 'swap', 'balance', 'position', 'yield', 'deposit', 'withdraw', 'rebalance', 'auto-rebalance', 'auto rebalance', 'enable rebalance', 'preference', 'slippage',
      'concentrated', 'range', 'price range', 'narrow', 'tight', 'out of range'
    ];
    
    const hasLpKeyword = lpKeywords.some(keyword => text.includes(keyword));
    console.info('[LpManagementAgentAction] Has LP keyword:', hasLpKeyword);
    
    return hasLpKeyword;
  },

  handler: async (runtime, message, state) => {
    console.info('[LpManagementAgentAction] Handler called with message:', message?.content?.text || 'No text');
    
    // Try to get params from message content
    let params = message?.content as unknown as LpActionParams;
    
    // If no structured params, try to parse from text
    if (!params || !params.intent) {
      const text = message.content?.text || '';
      const parsedIntent = parseIntentFromMessage(text);
      if (parsedIntent) {
        params = parsedIntent;
        console.info('[LpManagementAgentAction] Parsed intent:', params.intent);
      } else {
        return { 
          success: true,
          text: "I can help you with LP management. Try saying things like 'help me get started with LP management', 'show my LP positions', or 'add liquidity to a pool'."
        };
      }
    }
    
    const userId = message.entityId || 'unknown-user';

    const vault = runtime.getService<IVaultService>('VaultService');
    const dex = runtime.getService<IDexInteractionService>('dex-interaction');
    const profileService = runtime.getService<IUserLpProfileService>('UserLpProfileService');

    if (!vault || !dex || !profileService) {
      return { success: false, text: 'LP management services are currently unavailable. Please try again later.' };
    }

    try {
        const profile = await profileService.getProfile(userId);

        if (params.intent !== 'onboard_lp' && !profile) {
            return { success: true, text: "It looks like you're new here! To manage LPs, you first need a secure vault. Say 'onboard me for lp management' to get started." };
        }
        
        switch (params.intent) {
            case 'onboard_lp': {
                if (profile) {
                    return { success: true, text: `You're already set up! Your vault address is: ${profile.vaultPublicKey}` };
                }
                const { publicKey, secretKeyEncrypted } = await vault.createVault(userId);
                const newProfile = await profileService.ensureProfile(userId, publicKey, secretKeyEncrypted);
                return { 
                    success: true,
                    text: `Welcome! I've created a new secure vault for you. **Your vault address is: ${newProfile.vaultPublicKey}**. Please send the assets you want me to manage to this address. Auto-rebalancing is currently **${newProfile.autoRebalanceConfig.enabled ? 'ON' : 'OFF'}**.` 
                };
            }
            
            case 'deposit_lp': {
                 if (!profile) throw new Error('Profile not found');
                 const { dexName, poolId, tokenAAmount, tokenBAmount, maxSlippageBps } = params;
                 
                 // If no specific pool info, show available pools
                 if (!dexName || !poolId) {
                     const pools = await dex.getPools();
                     if (pools.length === 0) {
                         return { success: true, text: 'No pools available at the moment. Please check back later.' };
                     }
                     
                     let poolList = 'Here are the available pools:\n\n';
                     pools.slice(0, 5).forEach((pool, idx) => {
                         poolList += `${idx + 1}. **${pool.displayName || pool.id}** on ${pool.dex}\n`;
                         poolList += `   - Tokens: ${pool.tokenA.symbol}/${pool.tokenB.symbol}\n`;
                         poolList += `   - APR: ${pool.apr?.toFixed(2) || 'N/A'}%\n`;
                         poolList += `   - TVL: $${pool.tvl?.toLocaleString() || 'N/A'}\n\n`;
                     });
                     
                     return { success: true, text: poolList + '\nTo deposit, specify the DEX and pool. For example: "deposit 100 USDC into pool X on Raydium"' };
                 }

                 const userVault = await vault.getVaultKeypair(userId, profile.encryptedSecretKey);
                 const result = await dex.addLiquidity({
                     userVault,
                     dexName,
                     poolId,
                     tokenAAmountLamports: tokenAAmount || '0',
                     tokenBAmountLamports: tokenBAmount,
                     slippageBps: maxSlippageBps || 50
                 });

                 if (!result.success) {
                    return { success: false, text: `Deposit failed: ${result.error}` };
                }

                return { success: true, text: `✅ Deposit successful! Your funds are now earning yield in the ${poolId} pool on ${dexName}. Transaction ID: \`${result.transactionId}\`` };
            }

            case 'withdraw_lp': {
                if (!profile) throw new Error('Profile not found');
                const { dexName: wd_dexName, poolId: wd_poolId, lpTokenAmount, percentage: wd_percentage } = params;
                if (!wd_dexName || !wd_poolId || (!lpTokenAmount && !wd_percentage)) {
                    return { success: true, text: 'To withdraw, please tell me the DEX, the pool, and the amount (e.g., "withdraw 50% from the SOL/USDC pool on Orca").' };
                }
                const wd_userVault = await vault.getVaultKeypair(userId, profile.encryptedSecretKey);
                const wd_result = await dex.removeLiquidity({
                    userVault: wd_userVault,
                    dexName: wd_dexName,
                    poolId: wd_poolId,
                    lpTokenAmountLamports: lpTokenAmount || '0',
                    slippageBps: profile.autoRebalanceConfig.maxSlippageBps || 50
                });

                if (!wd_result.success) {
                    return { success: false, text: `Withdrawal failed: ${wd_result.error}` };
                }

                return { success: true, text: `✅ Withdrawal successful from ${wd_poolId}. Transaction ID: \`${wd_result.transactionId}\`` };
            }

            case 'show_lps': {
                const positions = await dex.getAllUserLpPositions(userId);
                return { success: true, text: formatPositions(positions) };
            }

            case 'set_lp_preferences': {
                if (!profile) throw new Error('Profile not found');
                const { autoRebalanceEnabled, minGainThresholdPercent, maxSlippageBps: pref_maxSlippageBps } = params;
                const newConfig = { ...profile.autoRebalanceConfig };
                
                let updateSummary = "LP preferences updated:\n";

                if (autoRebalanceEnabled !== undefined) {
                    newConfig.enabled = autoRebalanceEnabled;
                    updateSummary += `- Auto-Rebalance: ${newConfig.enabled ? '**ON**' : '**OFF**'}\n`;
                }
                if (minGainThresholdPercent !== undefined) {
                    newConfig.minGainThresholdPercent = minGainThresholdPercent;
                    updateSummary += `- Minimum Gain Threshold: **${minGainThresholdPercent}%**\n`;
                }
                if (pref_maxSlippageBps !== undefined) {
                    newConfig.maxSlippageBps = pref_maxSlippageBps;
                    updateSummary += `- Max Slippage: **${pref_maxSlippageBps / 100}%**\n`;
                }
                await profileService.updateProfile(userId, { autoRebalanceConfig: newConfig });
                return { success: true, text: updateSummary };
            }

            case 'create_concentrated_lp': {
                if (!profile) throw new Error('Profile not found');
                return { 
                    success: true,
                    text: "Concentrated liquidity positions allow you to provide liquidity within a specific price range for higher capital efficiency. This feature is coming soon! For now, you can use standard liquidity pools." 
                };
            }

            case 'show_concentrated_lps': {
                if (!profile) throw new Error('Profile not found');
                return { 
                    success: true,
                    text: "Concentrated liquidity position tracking is coming soon! For now, you can view your standard LP positions with 'show my positions'." 
                };
            }

            case 'rebalance_concentrated_lp': {
                if (!profile) throw new Error('Profile not found');
                return { 
                    success: true,
                    text: "Concentrated liquidity rebalancing is coming soon! This will allow you to adjust your price ranges when the market moves." 
                };
            }

            default:
                return { success: true, text: `I'm not sure how to handle the intent '${params.intent}'. I can help you deposit, withdraw, show your LP positions, or manage concentrated liquidity ranges.` };
        }

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[LpManagementAgentAction] Error: ${errorMessage}`);
        return { success: false, text: `An unexpected error occurred: ${errorMessage}` };
    }
  }
};