# NVIDIA NIM Plugin

## Purpose

This plugin provides integration with NVIDIA AI Foundation Models through various specialized actions for content analysis and safety checks.

## Installation

1. Create a free account at [NVIDIA AI Foundation Models](https://build.nvidia.com/models)
2. Generate required API keys: `NVIDIA_NIM_API_KEY` and `NVIDIA_NGC_API_KEY`
3. Create a `.env` file with necessary configurations

## Key Features

- AI Image Detection: Analyzes if images are AI-generated
- Cosmos Vision Analysis: Analyzes images and videos using multimodal vision-language model
- DeepFake Detection: Detects manipulation in images, focusing on facial modifications
- Jailbreak Detection: Analyzes prompts for attempts to bypass AI safety measures
- Content Safety Analysis: Evaluates messages for safety and policy compliance
- Topic Control: Determines if messages stay within defined topical boundaries

## Example Usage

Test prompts are provided for each feature, including AI image detection, deepfake detection, cosmos vision analysis, topic control, and content safety checks.
