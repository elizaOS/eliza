#!/usr/bin/env node

import https from 'https';

// Update this with your real API key
const API_KEY = process.env.TOGETHER_API_KEY || 'YOUR_API_KEY_HERE';

async function testConnection() {
  console.log('🔍 Testing Together.ai API Connection');
  console.log('====================================');
  
  if (!API_KEY || API_KEY === 'YOUR_API_KEY_HERE') {
    console.error('❌ Please set your API key!');
    console.error('   Option 1: export TOGETHER_API_KEY=your_real_key');
    console.error('   Option 2: Edit this script and replace YOUR_API_KEY_HERE');
    return;
  }
  
  console.log(`🔑 Using API key: ${API_KEY.substring(0, 8)}...`);
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: 'meta-llama/Llama-2-7b-chat-hf',
      messages: [{ role: 'user', content: 'Hello, world!' }],
      max_tokens: 10
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
        console.log(`📡 HTTP Status: ${res.statusCode}`);
        
        try {
          const response = JSON.parse(data);
          
          if (res.statusCode === 200) {
            console.log('✅ API connection successful!');
            console.log(`📝 Response: ${response.choices[0].message.content}`);
            console.log('\n🎯 Your API key is working. You can now test your fine-tuned model.');
          } else {
            console.log('❌ API Error:');
            console.log(JSON.stringify(response, null, 2));
          }
        } catch (error) {
          console.log('❌ Failed to parse response:');
          console.log(data);
        }
        
        resolve();
      });
    });

    req.on('error', (error) => {
      console.error('❌ Connection error:', error.message);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

testConnection().catch(console.error);