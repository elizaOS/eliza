# Anthropic Agent Integration
> Notice: As Anthropic API only supports image’s long edge is less than 1568 pixels and image is less than ~1,600 tokens, we resize the screenshot to 1280x720.
## Setup
To run with the Anthropic API, you need to set up your environment with the necessary API keys and configurations. Follow these steps:
1. **Install Dependencies**: Ensure you have the required Python packages installed. You can do this by running:
```bash
pip install anthropic
```
2. **Set Environment Variables**: You need to set the environment variable with your API key. You can do this in .env:
For aws bedrock:
```.env
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
```
For anthropic, you need set APIProvider to `anthropic` and set the API key:
```.env
ANTHROPIC_API_KEY=your_anthropic_api_key
```