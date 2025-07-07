// Netlify Serverless Function for AI Chat
// Place this file in /netlify/functions/predict.js for Netlify deployment

exports.handler = async (event, context) => {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { message, context: docContext } = JSON.parse(event.body);

    // Get OpenAI API key from environment
    const openAiKey = process.env.OPENAI_API_KEY;

    if (!openAiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'OpenAI API key not configured',
          response: 'Please configure OPENAI_API_KEY in your environment variables.',
        }),
      };
    }

    // Prepare the system prompt
    const systemPrompt = `You are the ElizaOS documentation assistant. ElizaOS is a powerful multi-agent simulation framework for building autonomous AI agents. 

Key features include:
- Multi-platform support (Discord, Twitter, Telegram, etc.)
- Plugin architecture for extensibility
- Memory and knowledge management
- Custom actions and behaviors
- Built with TypeScript
- CLI tools for easy setup: npm install -g @elizaos/cli

Always provide helpful, accurate, and concise answers based on the ElizaOS documentation. If you're unsure about something, say so rather than guessing.`;

    const userMessage =
      docContext && docContext.length > 0
        ? `Context from documentation:\n${docContext.join('\n')}\n\nUser question: ${message}`
        : message;

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI API error:', error);
      throw new Error('Failed to get AI response');
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;

    // Return response in the format expected by the AI widget
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        result: aiResponse,
        response: aiResponse,
        context: docContext || [],
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error('Chat API error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        response: 'I encountered an error processing your request. Please try again.',
      }),
    };
  }
};
