/**
 * AI Search Service for Docusaurus AI Plugin
 * This service handles AI-powered search queries for documentation
 */

export async function processAIQuery(query, context = []) {
  try {
    // Get AI configuration from environment
    const openAiKey = process.env.REACT_APP_OPENAI_API_KEY;
    const anthropicKey = process.env.REACT_APP_ANTHROPIC_API_KEY;
    const groqKey = process.env.REACT_APP_GROQ_API_KEY;

    // Prepare the prompt with context
    const systemPrompt = `You are ElizaOS documentation assistant. You help users understand and use the ElizaOS framework for building AI agents. 
    
    ElizaOS is a powerful multi-agent simulation framework designed to create, deploy, and manage autonomous AI agents. Key features include:
    - Multi-platform support (Discord, Twitter, Telegram, etc.)
    - Flexible plugin architecture
    - Memory and knowledge management
    - Custom actions and behaviors
    - Built with TypeScript
    
    Always provide helpful, accurate, and concise answers based on the documentation.`;

    const userPrompt =
      context.length > 0
        ? `Context from documentation:\n${context.join('\n')}\n\nUser question: ${query}`
        : `User question: ${query}`;

    // Use OpenAI if available
    if (openAiKey) {
      const response = await callOpenAI(systemPrompt, userPrompt, openAiKey);
      return { message: response, context };
    }

    // Use Anthropic if available
    if (anthropicKey) {
      const response = await callAnthropic(systemPrompt, userPrompt, anthropicKey);
      return { message: response, context };
    }

    // Use Groq if available
    if (groqKey) {
      const response = await callGroq(systemPrompt, userPrompt, groqKey);
      return { message: response, context };
    }

    // Fallback response
    return {
      message:
        'AI service is not configured. Please set up your AI API keys to enable intelligent responses.',
      context,
    };
  } catch (error) {
    console.error('AI Search Service Error:', error);
    return {
      message: 'I encountered an error processing your request. Please try again.',
      context,
    };
  }
}

async function callOpenAI(systemPrompt, userPrompt, apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4-turbo-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI API Error:', error);
    throw error;
  }
}

async function callAnthropic(systemPrompt, userPrompt, apiKey) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 500,
        messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }],
      }),
    });

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error('Anthropic API Error:', error);
    throw error;
  }
}

async function callGroq(systemPrompt, userPrompt, apiKey) {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'mixtral-8x7b-32768',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('Groq API Error:', error);
    throw error;
  }
}
