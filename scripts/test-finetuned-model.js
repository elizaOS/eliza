#!/usr/bin/env node

import https from 'https';

// Get API key from environment variable or use the provided one
const API_KEY = process.env.TOGETHER_API_KEY || '1ba7ad9a4c2d32b5f55ec2f66da8df82c8ba56edd4e6daa4e0b6c79ef97c32e14';
const API_URL = 'https://api.together.xyz/v1/chat/completions';

const FINE_TUNED_MODEL = 'moonmakesmagic/DeepSeek-R1-Distill-Qwen-1.5B-eliza-demo-f94707be';
const BASE_MODEL = 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B';

const TEST_PROMPT = `Create a Discord plugin for ElizaOS that responds to mentions. The plugin should:
1. Listen for messages that mention the bot
2. Extract the content after the mention
3. Generate a response using the agent's character
4. Reply in the same channel

Include proper TypeScript types and follow ElizaOS plugin architecture patterns.`;

async function makeRequest(model, prompt) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 1000,
      temperature: 0.7,
      top_p: 0.9,
      stream: false
    });

    const options = {
      hostname: 'api.together.xyz',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (res.statusCode !== 200) {
            console.log(`HTTP ${res.statusCode}: ${data}`);
          }
          resolve(response);
        } catch (error) {
          console.log(`Raw response: ${data}`);
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

async function testModel(modelName, label) {
  console.log(`\n🧪 Testing ${label}...`);
  console.log(`Model: ${modelName}`);
  console.log('=' * 60);
  
  try {
    const startTime = Date.now();
    const response = await makeRequest(modelName, TEST_PROMPT);
    const endTime = Date.now();
    
    if (response.error) {
      console.error(`❌ Error: ${response.error.message}`);
      return null;
    }
    
    if (!response.choices || response.choices.length === 0) {
      console.error('❌ No response choices returned');
      return null;
    }
    
    const content = response.choices[0].message.content;
    const responseTime = endTime - startTime;
    
    console.log(`✅ Response received in ${responseTime}ms`);
    console.log(`📊 Usage: ${response.usage?.prompt_tokens || 'N/A'} prompt tokens, ${response.usage?.completion_tokens || 'N/A'} completion tokens`);
    console.log('\n📝 Response:');
    console.log('-'.repeat(40));
    console.log(content);
    console.log('-'.repeat(40));
    
    return {
      content,
      responseTime,
      usage: response.usage,
      model: modelName
    };
    
  } catch (error) {
    console.error(`❌ Failed to test ${label}: ${error.message}`);
    return null;
  }
}

async function compareModels() {
  console.log('🚀 ElizaOS Fine-tuned Model Comparison Test');
  console.log('==========================================');
  console.log(`API Key: ${API_KEY.substring(0, 8)}...${API_KEY.substring(-8)}`);
  console.log(`Fine-tuned: ${FINE_TUNED_MODEL}`);
  console.log(`Base model: ${BASE_MODEL}`);
  console.log(`\n📋 Test prompt: "${TEST_PROMPT.substring(0, 100)}..."`);
  
  if (!API_KEY || API_KEY.length < 10) {
    console.error('❌ API key appears to be invalid or missing');
    console.error('💡 Set TOGETHER_API_KEY environment variable or update the script');
    return;
  }
  
  // Test fine-tuned model
  const fineTunedResult = await testModel(FINE_TUNED_MODEL, 'Fine-tuned Model');
  
  // Test base model for comparison
  const baseResult = await testModel(BASE_MODEL, 'Base Model');
  
  // Analysis
  console.log('\n📈 COMPARISON ANALYSIS');
  console.log('=====================');
  
  if (fineTunedResult && baseResult) {
    console.log(`⏱️  Response Time:`);
    console.log(`   Fine-tuned: ${fineTunedResult.responseTime}ms`);
    console.log(`   Base model: ${baseResult.responseTime}ms`);
    
    if (fineTunedResult.usage && baseResult.usage) {
      console.log(`\n📊 Token Usage:`);
      console.log(`   Fine-tuned: ${fineTunedResult.usage.completion_tokens} completion tokens`);
      console.log(`   Base model: ${baseResult.usage.completion_tokens} completion tokens`);
    }
    
    console.log(`\n🎯 Quality Assessment:`);
    console.log(`   Fine-tuned response length: ${fineTunedResult.content.length} chars`);
    console.log(`   Base model response length: ${baseResult.content.length} chars`);
    
    // Simple heuristics for ElizaOS-specific content
    const fineTunedElizaRefs = (fineTunedResult.content.match(/eliza|plugin|action|provider|runtime/gi) || []).length;
    const baseElizaRefs = (baseResult.content.match(/eliza|plugin|action|provider|runtime/gi) || []).length;
    
    console.log(`   Fine-tuned ElizaOS references: ${fineTunedElizaRefs}`);
    console.log(`   Base model ElizaOS references: ${baseElizaRefs}`);
    
    if (fineTunedElizaRefs > baseElizaRefs) {
      console.log(`   ✅ Fine-tuned model shows more ElizaOS-specific knowledge`);
    } else if (fineTunedElizaRefs < baseElizaRefs) {
      console.log(`   ⚠️  Base model shows more ElizaOS-specific knowledge`);
    } else {
      console.log(`   ➖ Similar ElizaOS-specific knowledge levels`);
    }
    
  } else if (fineTunedResult) {
    console.log('✅ Fine-tuned model working, base model failed');
  } else if (baseResult) {
    console.log('⚠️  Base model working, fine-tuned model failed');
  } else {
    console.log('❌ Both models failed');
  }
  
  console.log('\n🏁 Test completed!');
}

// Run the comparison
compareModels().catch(error => {
  console.error('💥 Script failed:', error.message);
  process.exit(1);
});