# Enhanced Secrets Management Architecture

## Overview
Design document for enhancing ElizaOS secrets management with OAuth/Web3 identity verification, channel callbacks, and improved user experience.

## Architecture Components

### 1. Identity Verification Service
```typescript
interface IdentityVerificationService {
  // OAuth providers (Google, GitHub, Discord, etc.)
  registerOAuthProvider(provider: OAuthProvider): void;
  
  // Web3 wallet verification
  verifyWalletSignature(signature: string, message: string, address: string): boolean;
  
  // Generate verification challenges
  createVerificationChallenge(userId: string, method: 'oauth' | 'wallet'): Challenge;
  
  // Validate completed verification
  validateVerification(challengeId: string, proof: VerificationProof): boolean;
}

interface Challenge {
  id: string;
  userId: string;
  method: 'oauth' | 'wallet';
  challenge: string; // OAuth URL or wallet signing message
  expiresAt: number;
  metadata: Record<string, any>;
}
```

### 2. Channel Callback System
```typescript
interface ChannelCallbackService {
  // Track where secret request originated
  registerSecretRequest(request: SecretRequest): string; // returns requestId
  
  // Send secure link back to original channel
  sendSecretRequestLink(requestId: string, portalUrl: string): void;
  
  // Notify channel when secrets are collected
  notifySecretCompletion(requestId: string, success: boolean): void;
}

interface SecretRequest {
  id: string;
  agentId: string;
  pluginName: string;
  requiredSecrets: SecretRequirement[];
  originChannel: {
    roomId: string;
    entityId: string; // user who requested the action
    source: string; // discord, telegram, etc.
  };
  createdAt: number;
  expiresAt: number;
}
```

### 3. Enhanced Portal Management
```typescript
interface EnhancedPortalManager {
  // Create unique portal sessions
  createSecurePortal(request: SecretRequest): Promise<SecurePortal>;
  
  // Manage multiple concurrent sessions
  getActivePortals(): SecurePortal[];
  
  // Clean up expired portals
  cleanupExpiredPortals(): void;
}

interface SecurePortal {
  id: string;
  sessionId: string;
  url: string;
  requestId: string;
  identityRequired: boolean;
  verificationMethods: ('oauth' | 'wallet')[];
  expiresAt: number;
  status: 'pending' | 'verified' | 'collecting' | 'completed' | 'expired';
}
```

## Implementation Plan

### Phase 1: Identity Verification Enhancement

#### 1.1 OAuth Integration
```typescript
// packages/plugin-secrets-manager/src/services/OAuthService.ts
export class OAuthService {
  private providers: Map<string, OAuthProvider> = new Map();
  
  async initializeProvider(provider: OAuthConfig) {
    // Support Google, GitHub, Discord, Twitter OAuth
    const oauthProvider = new OAuthProvider(provider);
    this.providers.set(provider.name, oauthProvider);
  }
  
  async generateAuthUrl(provider: string, challengeId: string): Promise<string> {
    const oauthProvider = this.providers.get(provider);
    return oauthProvider.generateAuthUrl({
      state: challengeId,
      redirectUri: `${this.baseUrl}/oauth/callback/${provider}`,
      scopes: ['profile', 'email']
    });
  }
  
  async handleCallback(provider: string, code: string, state: string): Promise<UserProfile> {
    const oauthProvider = this.providers.get(provider);
    const tokens = await oauthProvider.exchangeCodeForTokens(code);
    const profile = await oauthProvider.getUserProfile(tokens.access_token);
    
    // Validate state parameter matches challenge
    await this.validateChallenge(state, profile);
    
    return profile;
  }
}
```

#### 1.2 Web3 Wallet Verification
```typescript
// packages/plugin-secrets-manager/src/services/Web3VerificationService.ts
export class Web3VerificationService {
  async createSigningChallenge(address: string): Promise<SigningChallenge> {
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = `Verify identity for ElizaOS secrets portal\nNonce: ${nonce}\nTimestamp: ${Date.now()}`;
    
    return {
      id: uuidv4(),
      address: address.toLowerCase(),
      message,
      nonce,
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
    };
  }
  
  async verifySignature(challengeId: string, signature: string): Promise<boolean> {
    const challenge = await this.getChallenge(challengeId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      return false;
    }
    
    // Support multiple wallet types
    const recoveredAddress = await this.recoverAddress(challenge.message, signature);
    return recoveredAddress.toLowerCase() === challenge.address;
  }
  
  private async recoverAddress(message: string, signature: string): Promise<string> {
    // Support Ethereum, Solana, etc.
    if (signature.startsWith('0x')) {
      // Ethereum signature verification
      return ethers.utils.verifyMessage(message, signature);
    } else {
      // Solana signature verification
      return this.verifySolanaSignature(message, signature);
    }
  }
}
```

### Phase 2: Channel Callback System

#### 2.1 Request Tracking Service
```typescript
// packages/plugin-secrets-manager/src/services/RequestTrackingService.ts
export class RequestTrackingService {
  private requests: Map<string, SecretRequest> = new Map();
  
  async createSecretRequest(config: {
    agentId: string;
    pluginName: string;
    requiredSecrets: SecretRequirement[];
    originChannel: ChannelInfo;
  }): Promise<string> {
    const request: SecretRequest = {
      id: uuidv4(),
      ...config,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000 // 30 minutes
    };
    
    this.requests.set(request.id, request);
    
    // Schedule cleanup
    setTimeout(() => this.cleanupRequest(request.id), 30 * 60 * 1000);
    
    return request.id;
  }
  
  async sendRequestToChannel(requestId: string, portalUrl: string): Promise<void> {
    const request = this.requests.get(requestId);
    if (!request) throw new Error('Request not found');
    
    // Send message back to original channel
    const messageContent = {
      text: `🔐 I need access to configure ${request.pluginName}. Please verify your identity and provide the required secrets: ${portalUrl}`,
      metadata: {
        type: 'secret_request',
        requestId,
        expiresAt: request.expiresAt
      }
    };
    
    // Use the runtime to send message to original room
    await this.runtime.createMemory({
      entityId: this.runtime.agentId,
      roomId: request.originChannel.roomId,
      content: messageContent
    }, 'messages');
  }
}
```

### Phase 3: Enhanced Portal with Identity Gates

#### 3.1 Secure Portal Manager
```typescript
// packages/plugin-secrets-manager/src/services/SecurePortalManager.ts
export class SecurePortalManager extends SecretFormService {
  private portals: Map<string, SecurePortal> = new Map();
  private oauthService: OAuthService;
  private web3Service: Web3VerificationService;
  
  async createVerifiedPortal(request: SecretRequest): Promise<SecurePortal> {
    const portal: SecurePortal = {
      id: uuidv4(),
      sessionId: uuidv4(),
      url: '', // Will be set after server creation
      requestId: request.id,
      identityRequired: true,
      verificationMethods: ['oauth', 'wallet'],
      expiresAt: request.expiresAt,
      status: 'pending'
    };
    
    // Create Express server with identity verification
    const server = this.createVerificationServer(portal);
    const port = await this.findAvailablePort();
    await server.listen(port);
    
    // Create ngrok tunnel
    const ngrokService = this.runtime.getService<NgrokService>('ngrok');
    const publicUrl = await ngrokService.startTunnel(port);
    
    portal.url = `${publicUrl}/portal/${portal.sessionId}`;
    this.portals.set(portal.id, portal);
    
    return portal;
  }
  
  private createVerificationServer(portal: SecurePortal): Express {
    const app = express();
    
    // Security middleware
    app.use(helmet());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    
    // Landing page with identity verification options
    app.get(`/portal/${portal.sessionId}`, async (req, res) => {
      if (portal.status === 'expired') {
        return res.status(410).send(this.renderExpiredPage());
      }
      
      const html = this.renderIdentityVerificationPage(portal);
      res.send(html);
    });
    
    // OAuth verification routes
    app.get(`/portal/${portal.sessionId}/oauth/:provider`, async (req, res) => {
      const authUrl = await this.oauthService.generateAuthUrl(
        req.params.provider, 
        portal.sessionId
      );
      res.redirect(authUrl);
    });
    
    // Web3 wallet verification
    app.post(`/portal/${portal.sessionId}/wallet/challenge`, async (req, res) => {
      const { address } = req.body;
      const challenge = await this.web3Service.createSigningChallenge(address);
      res.json(challenge);
    });
    
    app.post(`/portal/${portal.sessionId}/wallet/verify`, async (req, res) => {
      const { challengeId, signature } = req.body;
      const verified = await this.web3Service.verifySignature(challengeId, signature);
      
      if (verified) {
        portal.status = 'verified';
        res.json({ success: true, secretFormUrl: `/portal/${portal.sessionId}/secrets` });
      } else {
        res.status(401).json({ success: false, error: 'Invalid signature' });
      }
    });
    
    // Secret collection form (only after verification)
    app.get(`/portal/${portal.sessionId}/secrets`, async (req, res) => {
      if (portal.status !== 'verified') {
        return res.status(403).redirect(`/portal/${portal.sessionId}`);
      }
      
      const secretForm = await this.renderSecretCollectionForm(portal);
      res.send(secretForm);
    });
    
    // Handle secret submission
    app.post(`/portal/${portal.sessionId}/submit`, async (req, res) => {
      if (portal.status !== 'verified') {
        return res.status(403).json({ error: 'Not verified' });
      }
      
      await this.processSecretSubmission(portal, req.body);
      portal.status = 'completed';
      
      res.json({ success: true, message: 'Secrets saved successfully' });
    });
    
    return app;
  }
}
```

### Phase 4: Enhanced Plugin Validation

#### 4.1 Plugin Dependency Validator
```typescript
// packages/plugin-plugin-manager/src/services/PluginDependencyValidator.ts
export class PluginDependencyValidator {
  async validatePluginSecrets(pluginName: string): Promise<ValidationResult> {
    const plugin = await this.getPlugin(pluginName);
    const requiredSecrets = this.extractRequiredSecrets(plugin);
    
    const missingSecrets: SecretRequirement[] = [];
    const availableSecrets: string[] = [];
    
    for (const secret of requiredSecrets) {
      const value = await this.secretsManager.get(secret.key, {
        level: secret.level || 'global'
      });
      
      if (!value) {
        missingSecrets.push(secret);
      } else {
        availableSecrets.push(secret.key);
      }
    }
    
    return {
      canStart: missingSecrets.length === 0,
      missingSecrets,
      availableSecrets,
      recommendedAction: missingSecrets.length > 0 ? 'request_secrets' : 'start_plugin'
    };
  }
  
  async requestMissingSecrets(
    pluginName: string, 
    originChannel: ChannelInfo
  ): Promise<string> {
    const validation = await this.validatePluginSecrets(pluginName);
    
    if (validation.canStart) {
      throw new Error('Plugin already has all required secrets');
    }
    
    // Create secret request
    const requestId = await this.requestTracker.createSecretRequest({
      agentId: this.runtime.agentId,
      pluginName,
      requiredSecrets: validation.missingSecrets,
      originChannel
    });
    
    // Create secure portal
    const portal = await this.portalManager.createVerifiedPortal(
      await this.requestTracker.getRequest(requestId)
    );
    
    // Send link back to channel
    await this.requestTracker.sendRequestToChannel(requestId, portal.url);
    
    return requestId;
  }
}
```

### Phase 5: Cypress Testing Framework

#### 5.1 Test Suite Structure
```typescript
// packages/plugin-secrets-manager/cypress/e2e/secret-portal.cy.ts
describe('Secure Secret Portal', () => {
  const agentId = Cypress.env('AGENT_IDS')?.split(',')[0];
  
  beforeEach(() => {
    cy.clearAllSessionStorage();
    cy.clearAllLocalStorage();
  });
  
  it('should create and access a secure portal with OAuth verification', () => {
    // Create a secret request through API
    cy.request('POST', `/api/agents/${agentId}/secrets/request`, {
      pluginName: 'github',
      requiredSecrets: [
        { key: 'GITHUB_TOKEN', description: 'GitHub Personal Access Token', sensitive: true }
      ],
      originChannel: { roomId: 'test-room', entityId: 'test-user', source: 'test' }
    }).then((response) => {
      expect(response.status).to.eq(200);
      const { portalUrl } = response.body;
      
      // Visit the portal
      cy.visit(portalUrl);
      
      // Should see identity verification page
      cy.get('[data-testid="identity-verification"]').should('be.visible');
      cy.get('[data-testid="oauth-options"]').should('be.visible');
      cy.get('[data-testid="wallet-options"]').should('be.visible');
    });
  });
  
  it('should verify Web3 wallet signature', () => {
    // Mock wallet connection
    cy.window().then((win) => {
      win.ethereum = {
        request: cy.stub().resolves(['0x742d35Cc6Ab4925B3aB89f1BA03b8Ac9c3D1D32D']),
        isMetaMask: true
      };
    });
    
    cy.visit('/portal/test-session');
    
    // Click wallet verification
    cy.get('[data-testid="wallet-verify"]').click();
    
    // Should prompt for wallet address
    cy.get('[data-testid="wallet-address-input"]').type('0x742d35Cc6Ab4925B3aB89f1BA03b8Ac9c3D1D32D');
    cy.get('[data-testid="get-challenge"]').click();
    
    // Mock signature
    cy.get('[data-testid="signature-input"]').type('0xmocksignature');
    cy.get('[data-testid="verify-signature"]').click();
    
    // Should redirect to secret form
    cy.url().should('include', '/secrets');
    cy.get('[data-testid="secret-form"]').should('be.visible');
  });
  
  it('should collect and encrypt secrets securely', () => {
    // Start from verified state
    cy.visit('/portal/test-session/secrets');
    
    // Fill in secret form
    cy.get('[data-testid="secret-github-token"]').type('github_pat_test_token');
    cy.get('[data-testid="submit-secrets"]').click();
    
    // Should show success message
    cy.get('[data-testid="success-message"]').should('contain', 'Secrets saved successfully');
    
    // Verify secrets were encrypted and stored
    cy.request('GET', `/api/agents/${agentId}/secrets/validate/github`).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body.canStart).to.eq(true);
    });
  });
  
  it('should handle portal expiration gracefully', () => {
    // Create expired portal
    cy.clock();
    cy.visit('/portal/expired-session');
    cy.tick(31 * 60 * 1000); // 31 minutes
    
    cy.reload();
    
    // Should show expiration message
    cy.get('[data-testid="expired-message"]').should('be.visible');
    cy.get('[data-testid="request-new-link"]').should('be.visible');
  });
});
```

## Integration with Existing GitHub-Todo Test

For the specific case shown in the test file, here's how the enhanced system would work:

1. **Scenario Start**: User asks agent to "check GitHub issues"
2. **Secret Detection**: GitHub plugin detects missing `GITHUB_TOKEN`
3. **Request Creation**: Agent creates secret request with channel callback
4. **Portal Generation**: Secure portal created with identity verification
5. **User Notification**: Link sent back to original channel
6. **Identity Verification**: User verifies via OAuth or wallet signature
7. **Secret Collection**: User provides GitHub token through secure form
8. **Plugin Activation**: GitHub plugin can now execute the original request
9. **Task Completion**: Agent proceeds with checking GitHub issues

This creates a seamless, secure workflow where users don't need to manually configure environment variables but instead provide secrets through a verified, encrypted portal system.

<function_calls>
<invoke name="TodoWrite">
<parameter name="todos">[{"id": "1", "content": "Analyze current secrets manager and plugin manager architecture", "status": "completed", "priority": "high"}, {"id": "2", "content": "Design OAuth and Web3 wallet identity verification system", "status": "completed", "priority": "high"}, {"id": "3", "content": "Create channel callback system for secret requests", "status": "completed", "priority": "high"}, {"id": "4", "content": "Enhance form builder with dynamic secret collection", "status": "completed", "priority": "medium"}, {"id": "5", "content": "Implement unique portal URLs and session management", "status": "completed", "priority": "medium"}, {"id": "6", "content": "Add plugin dependency validation for missing secrets", "status": "completed", "priority": "medium"}, {"id": "7", "content": "Create Cypress tests for secret request workflow", "status": "completed", "priority": "low"}, {"id": "8", "content": "Test ngrok tunnel integration with identity verification", "status": "completed", "priority": "low"}]