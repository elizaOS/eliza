---
sidebar_position: 13
---

# 🎯 Fine-tuning Guide

## What is Fine-tuning?

Fine-tuning is the process of taking an existing AI model and specializing it for your specific needs. Think of it like taking a general-purpose chef and training them to become an expert in your favorite cuisine - they keep their fundamental cooking skills but learn your specific recipes and preferences.

With fine-tuning, you can create models that:
- Write in your personal style 
- Specialize in your industry's terminology
- Match your brand's voice
- Understand your company's internal knowledge

## Getting Started

Guide for generating custom AI [character files](../core/characterfile.md) and training datasets using public data from Twitter and blogs. Just like choosing the right chef to train, picking the right base model is crucial. Together AI offers several options:

**For Beginners:**
- Llama 3 8B Instruct - Great for simpler tasks and smaller datasets
- Good for: Personal projects, testing fine-tuning, simpler use cases

**For Advanced Use Cases:**
- Llama 3 70B Instruct - Best for complex tasks and larger datasets
- Good for: Production applications, complex domain knowledge, nuanced interactions

There are two ways to prepare your data:

1. **JSONL Format** (Recommended for Beginners)
```json
{"text": "Your training example here"}
{"text": "Another training example"}
```
- Simpler to create and understand
- Works well for most use cases
- Handled automatically by the system

2. **Parquet Format** (Advanced)
- Pre-tokenized data
- More control over training
- Faster processing for multiple runs
- Recommended when you need custom loss masking

For this guide we're going to use JSONL format.

## Setup

We're going to use a tool to create a training dataset from sources like Twitter / Blogs: https://github.com/elizaOS/twitter-scraper-finetune. Alternatively you can also request a backup archive of your data from X and use this script: https://github.com/elizaOS/characterfile/blob/main/scripts/tweets2character.js, but then you'll miss the fine-tune parts of this guide.

### Prerequisites

- Node.js v22+
- Twitter credentials (username, password, email)
- Together AI API key
- Together CLI installed (`pip install together`)


1. Clone repo and install dependencies:
```bash
git clone git@github.com:elizaOS/twitter-scraper-finetune.git
cd twitter-scraper-finetune
npm install
```

2. Copy the `.env.example` into a `.env` file:

```properties
# (Required) Twitter Authentication
TWITTER_USERNAME=     # your twitter username
TWITTER_PASSWORD=     # your twitter password

# (Optional) Blog Configuration
BLOG_URLS_FILE=      # path to file containing blog URLs

# (Optional) Scraping Configuration
MAX_TWEETS=          # max tweets to scrape
MAX_RETRIES=         # max retries for scraping
RETRY_DELAY=         # delay between retries
MIN_DELAY=           # minimum delay between requests
MAX_DELAY=           # maximum delay between requests
```

## Usage

### Fetching Tweets

First configure collection parameters in `.env`.

Then to get tweets from a user:

```bash
npm run twitter -- username
```

This will:
- Authenticate with Twitter
- Collect tweets from the specified user
- Save raw tweets and analytics to `pipeline/[username]/[date]/`
- Generate engagement statistics and content analysis

### 2. Generating Character Files

After collecting tweets, you can generate a character file:

```bash 
npm run character -- username
```

This creates:
- A character.json file with personality traits
- Interaction style and behavioral patterns
- Sample responses and communication style
- System prompts for different contexts

### 3. Creating Fine-tuning Datasets

The pipeline automatically creates fine-tuning datasets during tweet collection. The datasets are stored in:

```
pipeline/[username]/[date]/processed/finetuning.jsonl
```

The JSONL file contains processed tweets optimized for fine-tuning, with:
- Cleaned text content
- Removed URLs and special characters
- Filtered based on engagement metrics
- Formatted for training

### 4. Fine-tuning Models

To start fine-tuning:

```bash
npm run finetune
```

:::tip
Optional test mode:
```bash
npm run finetune:test
```
:::

The fine-tuning process:
1. Validates the JSONL file format
2. Uploads data to Together AI
3. Initiates LoRA fine-tuning
4. Provides job ID for monitoring

Default model: meta-llama/Meta-Llama-3-70B-Instruct

You can monitor your fine-tuning job:
```bash
together fine-tuning retrieve [job_id]
```

Or check status at: https://api.together.xyz/jobs

The fine-tuning script (`scripts/finetune.js`) allows configuration of:
- Model selection
- Training parameters 
- LoRA settings
- Together AI options

## Output Structure

```
pipeline/
  └── [username]/
      └── [date]/
          ├── raw/
          │   ├── tweets.json
          │   └── urls.txt  
          ├── processed/
          │   └── finetuning.jsonl
          ├── analytics/
          │   └── stats.json
          ├── character/
          │   └── character.json
          └── exports/
              └── summary.md
```


## FAQ

### How much data do I need for good results?
Collect at least 1000 tweets from accounts with consistent posting styles, and filter for high engagement examples. Remove irrelevant or low-quality content, and clean out any sensitive or private info.

### What should I do after generating a character file?
Review and manually adjust the generated files, add specific behavioral examples, and fine-tune the system prompts for optimal outcomes.

### What are best practices for fine-tuning?
Start with test runs to validate your data, then closely monitor training metrics and thoroughly evaluate outputs before deployment.

### How can I make my agent's responses more natural/less bot-like?
Fine-tune the character's bio, lore, and post examples in the character file. Consider using different model providers and adjusting interaction settings. Some models (like DeepSeek) are noted for more natural responses.

### Why am I getting Twitter authentication failures?
Double-check your credentials in .env file, ensure your email is verified, and try adding rate limiting breaks between authentication attempts.

### Why isn't my data collection working?
Verify your network connectivity is stable, confirm the target account is public, and try increasing the retry parameters in your configuration.

### What should I do if I get fine-tuning errors?
First validate your JSONL file format is correct, then check your API key has proper permissions, and monitor any rate limits that may be affecting the process.