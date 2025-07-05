import React, { useState, useEffect, useRef } from 'react';
import {
  MessageCircle,
  X,
  Send,
  Sparkles,
  Settings,
  Key,
  AlertCircle,
} from 'lucide-react';
import ElizaAssistant from '../../services/elizaAssistant';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  error?: boolean;
}

export default function AIAssistant(): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [assistant, setAssistant] = useState<ElizaAssistant | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Initial welcome message
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        {
          id: '1',
          role: 'assistant',
          content: "Hi! I'm Eliza, your ElizaOS documentation assistant. I can help you understand the framework, explain concepts, provide code examples, and guide you through implementation. What would you like to learn about?",
          timestamp: new Date(),
        },
      ]);
    }
  }, []);

  // Instantiate assistant once on mount
  useEffect(() => {
    try {
      setAssistant(new ElizaAssistant());
    } catch (err) {
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'assistant',
        content: 'Server misconfiguration: OPENAI_API_KEY is missing. Please contact the administrator.',
        timestamp: new Date(),
        error: true,
      }]);
    }
  }, []);

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return;

    if (!assistant) {
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'assistant',
        content: 'AI assistant is not available. Please contact the administrator.',
        timestamp: new Date(),
        error: true,
      }]);
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsTyping(true);

    try {
      const response = await assistant.getQuickResponse(inputValue);

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.message,
        timestamp: new Date(),
        error: !!response.error,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error getting response:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Sorry, I encountered an error. Please contact the administrator.',
        timestamp: new Date(),
        error: true,
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="ai-assistant-container">
      {/* Floating button */}
      <button
        onClick={() => setIsOpen(true)}
        className="ai-assistant-button"
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          width: '60px',
          height: '60px',
          borderRadius: '50%',
          backgroundColor: '#3b82f6',
          color: 'white',
          border: 'none',
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          zIndex: 1000,
          display: isOpen ? 'none' : 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.3s ease',
        }}
        title="Ask Eliza"
      >
        <Sparkles size={24} />
      </button>

      {/* Chat interface */}
      {isOpen && (
        <div
          className="ai-assistant-chat"
          style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: '400px',
            height: '600px',
            backgroundColor: 'var(--ifm-background-color)',
            borderRadius: '12px',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.2)',
            zIndex: 1001,
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid var(--ifm-color-emphasis-200)',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '16px',
              borderBottom: '1px solid var(--ifm-color-emphasis-200)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: 'var(--ifm-color-emphasis-100)',
              borderRadius: '12px 12px 0 0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkles size={20} color="#3b82f6" />
              <span style={{ fontWeight: 'bold', color: 'var(--ifm-color-content)' }}>
                Eliza Assistant
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                  color: 'var(--ifm-color-content-secondary)',
                }}
                title="Close"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div
            style={{
              flex: 1,
              padding: '16px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            {messages.map((message) => (
              <div
                key={message.id}
                style={{
                  display: 'flex',
                  justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <div
                  style={{
                    maxWidth: '80%',
                    padding: '12px',
                    borderRadius: '12px',
                    backgroundColor: message.role === 'user'
                      ? '#3b82f6'
                      : message.error
                        ? '#ef4444'
                        : 'var(--ifm-color-emphasis-200)',
                    color: message.role === 'user' || message.error ? 'white' : 'var(--ifm-color-content)',
                    fontSize: '14px',
                    lineHeight: '1.4',
                    wordBreak: 'break-word',
                  }}
                >
                  {message.error && (
                    <AlertCircle size={16} style={{ display: 'inline', marginRight: '8px' }} />
                  )}
                  {message.content}
                </div>
              </div>
            ))}

            {isTyping && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div
                  style={{
                    padding: '12px',
                    borderRadius: '12px',
                    backgroundColor: 'var(--ifm-color-emphasis-200)',
                    color: 'var(--ifm-color-content)',
                    fontSize: '14px',
                  }}
                >
                  <span>Eliza is typing...</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div
            style={{
              padding: '16px',
              borderTop: '1px solid var(--ifm-color-emphasis-200)',
              display: 'flex',
              gap: '8px',
              alignItems: 'flex-end',
            }}
          >
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Ask me about ElizaOS..."
              disabled={isTyping}
              rows={1}
              style={{
                flex: 1,
                padding: '8px',
                border: '1px solid var(--ifm-color-emphasis-300)',
                borderRadius: '8px',
                fontSize: '14px',
                resize: 'none',
                backgroundColor: 'var(--ifm-background-color)',
                color: 'var(--ifm-color-content)',
                minHeight: '36px',
                maxHeight: '100px',
              }}
            />
            <button
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || isTyping}
              style={{
                backgroundColor: '#3b82f6',
                color: 'white',
                border: 'none',
                padding: '8px',
                borderRadius: '8px',
                cursor: inputValue.trim() && !isTyping ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '36px',
                height: '36px',
                opacity: inputValue.trim() && !isTyping ? 1 : 0.6,
              }}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
