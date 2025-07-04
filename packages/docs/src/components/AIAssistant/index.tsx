import React, { useState, useEffect, useRef } from 'react';
import {
  MessageCircle,
  X,
  Send,
  Sparkles,
  BookOpen,
  Code,
  Lightbulb,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react';
import { useHistory, useLocation } from '@docusaurus/router';
import styles from './styles.module.css';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  suggestions?: string[];
  links?: Array<{ title: string; url: string; description: string }>;
  codeSnippets?: Array<{ language: string; code: string; description: string }>;
}

interface DocumentationContext {
  currentPage: string;
  pageTitle: string;
  pageContent: string;
  userTrack: 'simple' | 'customize' | 'technical' | 'general';
  previousPages: string[];
}

export default function AIAssistant(): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [context, setContext] = useState<DocumentationContext>({
    currentPage: '',
    pageTitle: '',
    pageContent: '',
    userTrack: 'general',
    previousPages: [],
  });
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const history = useHistory();
  const location = useLocation();

  // Initialize with welcome message
  useEffect(() => {
    if (messages.length === 0) {
      const welcomeMessage: Message = {
        id: 'welcome',
        type: 'assistant',
        content:
          "👋 Hi! I'm your ElizaOS documentation assistant. I can help you find information, explain concepts, and guide you through setup. What would you like to know?",
        timestamp: new Date(),
        suggestions: [
          'How do I get started with ElizaOS?',
          "What's the difference between the documentation tracks?",
          'How do I create my first agent?',
          'Show me the API reference',
          'Help me troubleshoot an issue',
        ],
      };
      setMessages([welcomeMessage]);
    }
  }, [messages.length]);

  // Update context when page changes
  useEffect(() => {
    const currentPath = location.pathname;
    const pageTitle = document.title;

    // Determine user track based on current path
    let userTrack: 'simple' | 'customize' | 'technical' | 'general' = 'general';
    if (currentPath.includes('/simple/')) userTrack = 'simple';
    else if (currentPath.includes('/customize/')) userTrack = 'customize';
    else if (currentPath.includes('/technical/')) userTrack = 'technical';

    setContext((prev) => ({
      ...prev,
      currentPage: currentPath,
      pageTitle,
      userTrack,
      previousPages: [...prev.previousPages, currentPath].slice(-5), // Keep last 5 pages
    }));
  }, [location]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // AI-powered response generation
  const generateResponse = async (userMessage: string): Promise<Message> => {
    const messageId = Date.now().toString();

    // Simulate AI processing delay
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000));

    // Context-aware response generation
    const responses = getContextualResponse(userMessage, context);

    return {
      id: messageId,
      type: 'assistant',
      content: responses.content,
      timestamp: new Date(),
      suggestions: responses.suggestions,
      links: responses.links,
      codeSnippets: responses.codeSnippets,
    };
  };

  // Context-aware response logic
  const getContextualResponse = (userMessage: string, context: DocumentationContext) => {
    const lowerMessage = userMessage.toLowerCase();

    // Getting started queries
    if (
      lowerMessage.includes('get started') ||
      lowerMessage.includes('begin') ||
      lowerMessage.includes('start')
    ) {
      return {
        content: `Great! I'll help you get started with ElizaOS. Based on your current location, I recommend starting with the ${context.userTrack} track. Here's what you need to know:`,
        suggestions: [
          'Show me installation instructions',
          'What are the system requirements?',
          'How do I create my first agent?',
          "What's the difference between tracks?",
        ],
        links: [
          {
            title: 'Quick Start Guide',
            url: '/docs/quickstart',
            description: 'Get up and running in 5 minutes',
          },
          {
            title: 'Installation',
            url: '/docs/installation',
            description: 'Detailed installation instructions',
          },
          {
            title: 'Your First Agent',
            url: '/docs/tutorials/first-agent',
            description: 'Step-by-step agent creation',
          },
        ],
      };
    }

    // Agent creation queries
    if (lowerMessage.includes('agent') || lowerMessage.includes('create')) {
      return {
        content:
          "Creating an agent in ElizaOS is straightforward! Here's a basic example to get you started:",
        suggestions: [
          'How do I configure agent memory?',
          'What are agent personalities?',
          'How do I add custom actions?',
          'Show me advanced agent features',
        ],
        links: [
          {
            title: 'Agent Configuration',
            url: '/docs/core/agents',
            description: 'Complete agent configuration guide',
          },
          {
            title: 'Agent Templates',
            url: '/docs/guides/agent-templates',
            description: 'Pre-built agent templates',
          },
        ],
        codeSnippets: [
          {
            language: 'javascript',
            code: `import { createAgent } from "@elizaos/core";

const agent = await createAgent({
  name: "MyAgent",
  personality: "helpful and friendly",
  knowledge: ["general", "tech"],
  actions: ["chat", "search", "help"]
});

await agent.start();`,
            description: 'Basic agent creation',
          },
        ],
      };
    }

    // Plugin development queries
    if (lowerMessage.includes('plugin') || lowerMessage.includes('extend')) {
      return {
        content:
          "Plugins are a powerful way to extend ElizaOS! Here's how to create your first plugin:",
        suggestions: [
          'What types of plugins can I create?',
          'How do I register a plugin?',
          'Show me plugin examples',
          'Plugin development best practices',
        ],
        links: [
          {
            title: 'Plugin Development',
            url: '/docs/plugins/development',
            description: 'Complete plugin development guide',
          },
          { title: 'Plugin API', url: '/api/plugins', description: 'Plugin API reference' },
        ],
        codeSnippets: [
          {
            language: 'typescript',
            code: `import { Plugin } from "@elizaos/core";

export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "A custom plugin",
  actions: [
    {
      name: "customAction",
      description: "Does something awesome",
      handler: async (context) => {
        // Your custom logic here
        return { success: true };
      }
    }
  ]
};`,
            description: 'Basic plugin structure',
          },
        ],
      };
    }

    // API queries
    if (lowerMessage.includes('api') || lowerMessage.includes('reference')) {
      return {
        content:
          'The ElizaOS API is comprehensive and well-documented. Here are the main API categories:',
        suggestions: [
          'Show me agent API methods',
          'How do I authenticate API requests?',
          'What are the rate limits?',
          'API examples and tutorials',
        ],
        links: [
          { title: 'API Reference', url: '/api', description: 'Complete API documentation' },
          { title: 'REST API', url: '/api/rest', description: 'REST API endpoints' },
          { title: 'Authentication', url: '/api/auth', description: 'API authentication guide' },
        ],
      };
    }

    // Troubleshooting queries
    if (
      lowerMessage.includes('error') ||
      lowerMessage.includes('problem') ||
      lowerMessage.includes('help')
    ) {
      return {
        content:
          "I'm here to help troubleshoot! Can you tell me more about the specific issue you're experiencing?",
        suggestions: [
          "Agent won't start",
          'Installation problems',
          'Configuration issues',
          'Plugin not loading',
        ],
        links: [
          {
            title: 'Troubleshooting Guide',
            url: '/docs/troubleshooting',
            description: 'Common issues and solutions',
          },
          {
            title: 'Community Support',
            url: '/community',
            description: 'Get help from the community',
          },
        ],
      };
    }

    // Track-specific guidance
    if (lowerMessage.includes('track') || lowerMessage.includes('path')) {
      return {
        content: `You're currently viewing the ${context.userTrack} track. Here's what each track offers:

**🎯 Simple Track**: Perfect for non-technical users who want to use ElizaOS without coding
**🎨 Customize Track**: For power users who want to customize and configure agents
**🔧 Technical Track**: For developers who want to build and extend ElizaOS`,
        suggestions: [
          'Switch to Simple track',
          'Switch to Customize track',
          'Switch to Technical track',
          "What's best for my use case?",
        ],
        links: [
          { title: 'Simple Track', url: '/docs/simple', description: 'Non-technical user guide' },
          {
            title: 'Customize Track',
            url: '/docs/customize',
            description: 'Power user customization',
          },
          {
            title: 'Technical Track',
            url: '/docs/technical',
            description: 'Developer documentation',
          },
        ],
      };
    }

    // Default response
    return {
      content:
        "I understand you're looking for information about ElizaOS. Could you be more specific about what you'd like to know? I can help with setup, configuration, development, or troubleshooting.",
      suggestions: [
        'Getting started guide',
        'Agent creation',
        'Plugin development',
        'API reference',
        'Troubleshooting',
      ],
      links: [
        { title: 'Documentation Home', url: '/docs', description: 'Main documentation' },
        { title: 'Community', url: '/community', description: 'Community resources' },
      ],
    };
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content: inputValue.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsTyping(true);

    try {
      const assistantMessage = await generateResponse(inputValue.trim());
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: Message = {
        id: Date.now().toString(),
        type: 'assistant',
        content:
          "I apologize, but I'm having trouble processing your request right now. Please try again or check our documentation directly.",
        timestamp: new Date(),
        links: [
          { title: 'Documentation', url: '/docs', description: 'Browse the full documentation' },
          {
            title: 'Community Support',
            url: '/community',
            description: 'Get help from the community',
          },
        ],
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setInputValue(suggestion);
    setTimeout(() => handleSendMessage(), 100);
  };

  const handleLinkClick = (url: string) => {
    history.push(url);
    setIsOpen(false);
  };

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (error) {
      console.error('Failed to copy code:', error);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <>
      {/* Floating Button */}
      <button
        className={`${styles.floatingButton} ${isOpen ? styles.hidden : ''}`}
        onClick={() => setIsOpen(true)}
        aria-label="Open AI Assistant"
      >
        <Sparkles size={24} />
      </button>

      {/* Assistant Panel */}
      {isOpen && (
        <div className={styles.assistantPanel}>
          <div className={styles.header}>
            <div className={styles.headerContent}>
              <Sparkles size={20} />
              <h3>ElizaOS Assistant</h3>
            </div>
            <button
              className={styles.closeButton}
              onClick={() => setIsOpen(false)}
              aria-label="Close Assistant"
            >
              <X size={20} />
            </button>
          </div>

          <div className={styles.messagesContainer}>
            {messages.map((message) => (
              <div key={message.id} className={`${styles.message} ${styles[message.type]}`}>
                <div className={styles.messageContent}>
                  {message.type === 'assistant' && (
                    <div className={styles.messageIcon}>
                      <Sparkles size={16} />
                    </div>
                  )}
                  <div className={styles.messageText}>{message.content}</div>
                </div>

                {/* Suggestions */}
                {message.suggestions && (
                  <div className={styles.suggestions}>
                    {message.suggestions.map((suggestion, index) => (
                      <button
                        key={index}
                        className={styles.suggestionButton}
                        onClick={() => handleSuggestionClick(suggestion)}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}

                {/* Links */}
                {message.links && (
                  <div className={styles.links}>
                    {message.links.map((link, index) => (
                      <button
                        key={index}
                        className={styles.linkButton}
                        onClick={() => handleLinkClick(link.url)}
                      >
                        <div className={styles.linkContent}>
                          <div className={styles.linkTitle}>
                            <BookOpen size={16} />
                            {link.title}
                          </div>
                          <div className={styles.linkDescription}>{link.description}</div>
                        </div>
                        <ExternalLink size={16} />
                      </button>
                    ))}
                  </div>
                )}

                {/* Code Snippets */}
                {message.codeSnippets && (
                  <div className={styles.codeSnippets}>
                    {message.codeSnippets.map((snippet, index) => (
                      <div key={index} className={styles.codeSnippet}>
                        <div className={styles.codeHeader}>
                          <span className={styles.codeLanguage}>
                            <Code size={16} />
                            {snippet.language}
                          </span>
                          <span className={styles.codeDescription}>{snippet.description}</span>
                          <button
                            className={styles.copyButton}
                            onClick={() => handleCopyCode(snippet.code)}
                          >
                            {copiedCode === snippet.code ? <Check size={16} /> : <Copy size={16} />}
                          </button>
                        </div>
                        <pre className={styles.codeBlock}>
                          <code>{snippet.code}</code>
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <div className={`${styles.message} ${styles.assistant}`}>
                <div className={styles.messageContent}>
                  <div className={styles.messageIcon}>
                    <Sparkles size={16} />
                  </div>
                  <div className={styles.typingIndicator}>
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className={styles.inputContainer}>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Ask me anything about ElizaOS..."
              className={styles.input}
              disabled={isTyping}
            />
            <button
              className={styles.sendButton}
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || isTyping}
              aria-label="Send message"
            >
              <Send size={20} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
