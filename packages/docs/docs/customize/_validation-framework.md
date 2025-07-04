# Real-Time Validation Framework

This document outlines the shared validation framework used across all ElizaOS interactive tools. This framework provides consistent validation patterns, styling, and user experience across the Environment Builder, Character Builder, Feature Workshop, and Analytics Dashboard.

## Core Validation Components

### 1. Live Validation States

```typescript
interface ValidationState {
  status: 'success' | 'warning' | 'error' | 'info' | 'loading';
  message: string;
  suggestions?: ValidationSuggestion[];
  score?: number;
}

interface ValidationSuggestion {
  type: 'fix' | 'optimize' | 'enhance';
  message: string;
  action?: string;
  autoApply?: boolean;
}
```

### 2. Real-Time Validation Hook

```typescript
const useRealTimeValidation = (value: any, rules: ValidationRule[]) => {
  const [validation, setValidation] = useState<ValidationState>();

  useEffect(() => {
    const validateValue = async () => {
      setValidation({ status: 'loading', message: 'Validating...' });

      try {
        const results = await Promise.all(rules.map((rule) => rule.validate(value)));

        const aggregated = aggregateValidationResults(results);
        setValidation(aggregated);
      } catch (error) {
        setValidation({
          status: 'error',
          message: 'Validation failed',
        });
      }
    };

    const debounced = debounce(validateValue, 300);
    debounced();

    return () => debounced.cancel();
  }, [value, rules]);

  return validation;
};
```

### 3. Validation Rules Library

```typescript
// Environment Validation Rules
export const environmentValidationRules = {
  apiKey: {
    openai: (key: string) => ({
      validate: async (key) => {
        if (!key.startsWith('sk-')) {
          return { status: 'error', message: 'OpenAI API keys must start with sk-' };
        }

        try {
          const response = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
          });

          if (response.ok) {
            const data = await response.json();
            return {
              status: 'success',
              message: `Connected successfully! Available models: ${data.data.length}`,
              suggestions: [
                {
                  type: 'optimize',
                  message: 'Consider setting usage limits to control costs',
                  action: 'configure-limits',
                },
              ],
            };
          } else {
            return { status: 'error', message: 'Invalid API key or insufficient permissions' };
          }
        } catch (error) {
          return { status: 'error', message: 'Unable to connect to OpenAI API' };
        }
      },
    }),

    discord: (token: string) => ({
      validate: async (token) => {
        if (!token.match(/^[A-Za-z0-9._-]{59}$/)) {
          return { status: 'error', message: 'Invalid Discord token format' };
        }

        try {
          const response = await fetch('https://discord.com/api/v10/applications/@me', {
            headers: { Authorization: `Bot ${token}` },
          });

          if (response.ok) {
            const app = await response.json();
            return {
              status: 'success',
              message: `Bot authenticated: ${app.name}`,
              suggestions: [
                {
                  type: 'enhance',
                  message: 'Set up slash commands for better user experience',
                  action: 'configure-slash-commands',
                },
              ],
            };
          } else {
            return { status: 'error', message: 'Invalid bot token or insufficient permissions' };
          }
        } catch (error) {
          return { status: 'error', message: 'Unable to verify Discord bot' };
        }
      },
    }),
  },

  database: {
    postgresql: (url: string) => ({
      validate: async (url) => {
        if (!url.startsWith('postgresql://')) {
          return { status: 'error', message: 'PostgreSQL URL must start with postgresql://' };
        }

        try {
          // Validate connection (mock implementation)
          const isValid = await validateDatabaseConnection(url);
          if (isValid) {
            return {
              status: 'success',
              message: 'Database connected successfully',
              suggestions: [
                {
                  type: 'optimize',
                  message: 'Consider adding connection pooling for better performance',
                  action: 'configure-pooling',
                },
              ],
            };
          } else {
            return { status: 'error', message: 'Unable to connect to database' };
          }
        } catch (error) {
          return { status: 'error', message: 'Database connection failed' };
        }
      },
    }),
  },
};

// Character Validation Rules
export const characterValidationRules = {
  personality: {
    coherence: (traits: PersonalityTraits) => ({
      validate: (traits) => {
        const conflicts = detectPersonalityConflicts(traits);
        if (conflicts.length === 0) {
          return {
            status: 'success',
            message: 'Personality traits are coherent and well-balanced',
            score: calculateCoherenceScore(traits),
          };
        } else {
          return {
            status: 'warning',
            message: `${conflicts.length} potential conflicts detected`,
            suggestions: conflicts.map((conflict) => ({
              type: 'fix',
              message: conflict.description,
              action: conflict.suggestedFix,
            })),
          };
        }
      },
    }),

    completeness: (character: CharacterConfig) => ({
      validate: (character) => {
        const missing = detectMissingRequiredFields(character);
        const score = calculateCompletenessScore(character);

        if (missing.length === 0) {
          return {
            status: 'success',
            message: 'Character configuration is complete',
            score,
          };
        } else {
          return {
            status: 'warning',
            message: `${missing.length} required fields missing`,
            suggestions: missing.map((field) => ({
              type: 'fix',
              message: `Add ${field.name}: ${field.description}`,
              action: `configure-${field.key}`,
            })),
          };
        }
      },
    }),
  },
};

// Feature Validation Rules
export const featureValidationRules = {
  compatibility: {
    platformSupport: (plugin: PluginConfig, platforms: string[]) => ({
      validate: (plugin, platforms) => {
        const supported = plugin.supportedPlatforms || [];
        const unsupported = platforms.filter((p) => !supported.includes(p));

        if (unsupported.length === 0) {
          return {
            status: 'success',
            message: 'Plugin supports all selected platforms',
          };
        } else {
          return {
            status: 'warning',
            message: `Plugin doesn't support: ${unsupported.join(', ')}`,
            suggestions: [
              {
                type: 'enhance',
                message: 'Consider finding alternative plugins for unsupported platforms',
                action: 'find-alternatives',
              },
            ],
          };
        }
      },
    }),

    dependencies: (plugin: PluginConfig, environment: EnvironmentConfig) => ({
      validate: (plugin, environment) => {
        const missing =
          plugin.requiredServices?.filter(
            (service) => !environment.enabledServices.includes(service)
          ) || [];

        if (missing.length === 0) {
          return {
            status: 'success',
            message: 'All plugin dependencies are satisfied',
          };
        } else {
          return {
            status: 'error',
            message: `Missing required services: ${missing.join(', ')}`,
            suggestions: missing.map((service) => ({
              type: 'fix',
              message: `Configure ${service} to use this plugin`,
              action: `configure-${service}`,
              autoApply: true,
            })),
          };
        }
      },
    }),
  },

  security: {
    permissions: (plugin: PluginConfig) => ({
      validate: (plugin) => {
        const riskyPermissions =
          plugin.permissions?.filter((perm) =>
            ['file-system', 'network', 'shell'].includes(perm)
          ) || [];

        if (riskyPermissions.length === 0) {
          return {
            status: 'success',
            message: 'Plugin permissions are safe',
          };
        } else {
          return {
            status: 'warning',
            message: `Plugin requests risky permissions: ${riskyPermissions.join(', ')}`,
            suggestions: [
              {
                type: 'enhance',
                message: 'Review plugin source code before installing',
                action: 'review-source',
              },
            ],
          };
        }
      },
    }),
  },
};
```

### 4. Validation UI Components

```typescript
// ValidationIndicator Component
export const ValidationIndicator: React.FC<{
  validation?: ValidationState;
  inline?: boolean;
}> = ({ validation, inline = false }) => {
  if (!validation) return null;

  const getStatusIcon = (status: ValidationState['status']) => {
    switch (status) {
      case 'success': return '✅';
      case 'warning': return '⚠️';
      case 'error': return '❌';
      case 'info': return 'ℹ️';
      case 'loading': return '🔄';
      default: return '';
    }
  };

  const getStatusColor = (status: ValidationState['status']) => {
    switch (status) {
      case 'success': return '#22c55e';
      case 'warning': return '#fbbf24';
      case 'error': return '#ef4444';
      case 'info': return '#3b82f6';
      case 'loading': return '#64748b';
      default: return '#64748b';
    }
  };

  return (
    <div className={`validation-indicator ${inline ? 'inline' : 'block'} ${validation.status}`}>
      <div className="validation-main">
        <span className="validation-icon">{getStatusIcon(validation.status)}</span>
        <span className="validation-message">{validation.message}</span>
        {validation.score && (
          <span className="validation-score">{validation.score}/10</span>
        )}
      </div>

      {validation.suggestions && validation.suggestions.length > 0 && (
        <div className="validation-suggestions">
          {validation.suggestions.map((suggestion, index) => (
            <ValidationSuggestion
              key={index}
              suggestion={suggestion}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ValidationSuggestion Component
export const ValidationSuggestion: React.FC<{
  suggestion: ValidationSuggestion;
}> = ({ suggestion }) => {
  const getSuggestionIcon = (type: ValidationSuggestion['type']) => {
    switch (type) {
      case 'fix': return '🔧';
      case 'optimize': return '⚡';
      case 'enhance': return '✨';
      default: return '💡';
    }
  };

  return (
    <div className="validation-suggestion">
      <span className="suggestion-icon">{getSuggestionIcon(suggestion.type)}</span>
      <span className="suggestion-message">{suggestion.message}</span>
      {suggestion.action && (
        <button
          className="suggestion-action"
          onClick={() => handleSuggestionAction(suggestion.action)}
        >
          {suggestion.autoApply ? 'Auto-Fix' : 'Apply'}
        </button>
      )}
    </div>
  );
};

// ValidationPanel Component
export const ValidationPanel: React.FC<{
  validations: ValidationState[];
  title?: string;
}> = ({ validations, title = 'Validation Results' }) => {
  const overallScore = validations.reduce((acc, val) =>
    acc + (val.score || 0), 0
  ) / validations.filter(val => val.score).length;

  return (
    <div className="validation-panel">
      <div className="validation-header">
        <h4>{title}</h4>
        {overallScore && (
          <div className="overall-score">
            <span className="score-value">{overallScore.toFixed(1)}</span>
            <span className="score-max">/10</span>
          </div>
        )}
      </div>

      <div className="validation-list">
        {validations.map((validation, index) => (
          <ValidationIndicator
            key={index}
            validation={validation}
          />
        ))}
      </div>
    </div>
  );
};
```

### 5. Shared CSS Framework

```css
/* Validation Framework Styles */
.validation-indicator {
  margin: 0.5rem 0;
  animation: fadeIn 0.3s ease-in-out;
}

.validation-indicator.inline {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.validation-indicator.block {
  display: block;
}

.validation-main {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
}

.validation-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.validation-message {
  flex: 1;
  font-size: 0.875rem;
  line-height: 1.4;
}

.validation-score {
  font-weight: 600;
  font-size: 0.875rem;
}

.validation-indicator.success {
  color: #22c55e;
}

.validation-indicator.warning {
  color: #fbbf24;
}

.validation-indicator.error {
  color: #ef4444;
}

.validation-indicator.info {
  color: #3b82f6;
}

.validation-indicator.loading {
  color: #64748b;
}

.validation-indicator.loading .validation-icon {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.validation-suggestions {
  margin-top: 0.75rem;
  padding-left: 1.75rem;
}

.validation-suggestion {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
}

.suggestion-icon {
  flex-shrink: 0;
}

.suggestion-message {
  flex: 1;
  color: white;
}

.suggestion-action {
  padding: 0.25rem 0.75rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 500;
  transition: all 0.2s ease;
}

.suggestion-action:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
}

.validation-panel {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 1.5rem;
  margin: 1rem 0;
  backdrop-filter: blur(10px);
}

.validation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.validation-header h4 {
  color: white;
  margin: 0;
  font-size: 1.125rem;
}

.overall-score {
  display: flex;
  align-items: baseline;
  gap: 0.25rem;
}

.score-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: #10b981;
}

.score-max {
  font-size: 1rem;
  color: rgba(255, 255, 255, 0.7);
}

.validation-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* Interactive Elements */
.validation-input-wrapper {
  position: relative;
}

.validation-input-wrapper .validation-indicator {
  margin-top: 0.5rem;
}

.validation-input-wrapper input:focus + .validation-indicator,
.validation-input-wrapper select:focus + .validation-indicator {
  opacity: 1;
  transform: translateY(0);
}

/* Loading States */
.validation-loading {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: #64748b;
  font-size: 0.875rem;
}

.validation-loading::before {
  content: '';
  width: 12px;
  height: 12px;
  border: 2px solid rgba(100, 116, 139, 0.3);
  border-top: 2px solid #64748b;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

/* Responsive Design */
@media (max-width: 768px) {
  .validation-main {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .validation-suggestion {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .suggestion-action {
    align-self: flex-end;
  }
}

/* Dark Mode Adjustments */
@media (prefers-color-scheme: dark) {
  .validation-panel {
    background: rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .validation-suggestion {
    background: rgba(0, 0, 0, 0.2);
  }
}

/* High Contrast Mode */
@media (prefers-contrast: high) {
  .validation-indicator.success {
    color: #00ff00;
  }

  .validation-indicator.warning {
    color: #ffff00;
  }

  .validation-indicator.error {
    color: #ff0000;
  }

  .validation-indicator.info {
    color: #00ffff;
  }
}
```

### 6. Integration Examples

#### Environment Builder Integration

```typescript
// In environment-builder.md
const EnvironmentBuilder = () => {
  const [config, setConfig] = useState<EnvironmentConfig>({});

  const openaiValidation = useRealTimeValidation(
    config.OPENAI_API_KEY,
    [environmentValidationRules.apiKey.openai]
  );

  const discordValidation = useRealTimeValidation(
    config.DISCORD_API_TOKEN,
    [environmentValidationRules.apiKey.discord]
  );

  return (
    <div className="environment-builder">
      <div className="config-section">
        <input
          type="password"
          placeholder="OpenAI API Key"
          value={config.OPENAI_API_KEY || ''}
          onChange={(e) => setConfig({...config, OPENAI_API_KEY: e.target.value})}
        />
        <ValidationIndicator validation={openaiValidation} />
      </div>

      <div className="config-section">
        <input
          type="password"
          placeholder="Discord Bot Token"
          value={config.DISCORD_API_TOKEN || ''}
          onChange={(e) => setConfig({...config, DISCORD_API_TOKEN: e.target.value})}
        />
        <ValidationIndicator validation={discordValidation} />
      </div>

      <ValidationPanel
        validations={[openaiValidation, discordValidation].filter(Boolean)}
        title="Environment Validation"
      />
    </div>
  );
};
```

#### Character Builder Integration

```typescript
// In character-builder.md
const CharacterBuilder = () => {
  const [character, setCharacter] = useState<CharacterConfig>({});

  const coherenceValidation = useRealTimeValidation(
    character.personality,
    [characterValidationRules.personality.coherence]
  );

  const completenessValidation = useRealTimeValidation(
    character,
    [characterValidationRules.personality.completeness]
  );

  return (
    <div className="character-builder">
      {/* Character configuration inputs */}

      <ValidationPanel
        validations={[coherenceValidation, completenessValidation].filter(Boolean)}
        title="Character Analysis"
      />
    </div>
  );
};
```

#### Feature Workshop Integration

```typescript
// In feature-workshop.md
const FeatureWorkshop = () => {
  const [selectedPlugin, setSelectedPlugin] = useState<PluginConfig>();
  const [environment, setEnvironment] = useState<EnvironmentConfig>({});

  const compatibilityValidation = useRealTimeValidation(
    { plugin: selectedPlugin, platforms: environment.platforms },
    [featureValidationRules.compatibility.platformSupport]
  );

  const dependencyValidation = useRealTimeValidation(
    { plugin: selectedPlugin, environment },
    [featureValidationRules.compatibility.dependencies]
  );

  const securityValidation = useRealTimeValidation(
    selectedPlugin,
    [featureValidationRules.security.permissions]
  );

  return (
    <div className="feature-workshop">
      {/* Plugin selection and configuration */}

      <ValidationPanel
        validations={[
          compatibilityValidation,
          dependencyValidation,
          securityValidation
        ].filter(Boolean)}
        title="Plugin Validation"
      />
    </div>
  );
};
```

This validation framework provides:

1. **Consistent Experience**: Same validation patterns across all tools
2. **Real-Time Feedback**: Immediate validation as users type or change settings
3. **Smart Suggestions**: AI-powered recommendations for improvements
4. **Accessibility**: Screen reader friendly and keyboard navigable
5. **Responsive Design**: Works well on all device sizes
6. **Extensible**: Easy to add new validation rules and components
7. **Performance**: Debounced validations to avoid excessive API calls
8. **Visual Consistency**: Follows the Apple Liquid Glass design aesthetic

The framework is designed to be imported and used across all interactive tools, ensuring a cohesive and professional user experience throughout the ElizaOS documentation ecosystem.
