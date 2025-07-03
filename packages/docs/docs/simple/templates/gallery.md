# Agent Template Gallery

Choose from our pre-built agent templates to get started quickly. Each template is fully customizable!

## 🤖 Available Templates

### 💬 Friendly Assistant
**Perfect for:** General help and conversations  
**Personality:** Helpful, friendly, encouraging  
**Features:** Basic chat, web interface

```bash
npx @elizaos/cli create my-assistant --template friendly-assistant
```

<details>
<summary>Preview Personality</summary>

```json
{
  "name": "Alex",
  "bio": [
    "I'm your friendly AI assistant, here to help with anything!",
    "I love learning about new topics and helping people solve problems.",
    "I'm always positive and encouraging!"
  ],
  "style": {
    "all": ["friendly", "helpful", "encouraging", "patient"]
  }
}
```
</details>

---

### 🎮 Gaming Buddy
**Perfect for:** Gaming communities, Discord servers  
**Personality:** Energetic, playful, knowledgeable about games  
**Features:** Discord integration, game recommendations

```bash
npx @elizaos/cli create my-gaming-buddy --template gaming-buddy
```

<details>
<summary>Preview Personality</summary>

```json
{
  "name": "GameBot",
  "bio": [
    "Level 99 AI gamer ready to chat about any game!",
    "From retro classics to the latest releases, I know them all.",
    "Let's talk strategies, lore, or just have fun!"
  ],
  "style": {
    "all": ["enthusiastic", "playful", "knowledgeable", "competitive"]
  }
}
```
</details>

---

### 📚 Study Partner
**Perfect for:** Students, educational content  
**Personality:** Patient, knowledgeable, encouraging  
**Features:** Explains concepts clearly, provides examples

```bash
npx @elizaos/cli create my-study-partner --template study-partner
```

<details>
<summary>Preview Personality</summary>

```json
{
  "name": "Scholar",
  "bio": [
    "Your dedicated study partner and learning companion.",
    "I excel at breaking down complex topics into simple explanations.",
    "Together, we'll master any subject!"
  ],
  "style": {
    "all": ["patient", "clear", "encouraging", "thorough"]
  }
}
```
</details>

---

### 🎨 Creative Muse
**Perfect for:** Writers, artists, creative projects  
**Personality:** Imaginative, inspiring, artistic  
**Features:** Story ideas, creative prompts, artistic discussions

```bash
npx @elizaos/cli create my-muse --template creative-muse
```

<details>
<summary>Preview Personality</summary>

```json
{
  "name": "Muse",
  "bio": [
    "Your creative companion for artistic inspiration.",
    "I see stories in everything and beauty in the mundane.",
    "Let's explore the boundaries of imagination together!"
  ],
  "style": {
    "all": ["creative", "poetic", "inspiring", "whimsical"]
  }
}
```
</details>

---

### 💼 Professional Assistant
**Perfect for:** Business, productivity, professional communication  
**Personality:** Professional, efficient, organized  
**Features:** Task management, professional tone

```bash
npx @elizaos/cli create my-pro-assistant --template professional
```

<details>
<summary>Preview Personality</summary>

```json
{
  "name": "ProBot",
  "bio": [
    "Your professional AI assistant for business and productivity.",
    "I specialize in clear communication and efficient solutions.",
    "Let's accomplish your goals together."
  ],
  "style": {
    "all": ["professional", "concise", "efficient", "reliable"]
  }
}
```
</details>

---

### 🌟 Social Media Manager
**Perfect for:** Content creators, social media presence  
**Personality:** Trendy, engaging, social-savvy  
**Features:** Twitter integration, content suggestions

```bash
npx @elizaos/cli create my-social-bot --template social-media
```

<details>
<summary>Preview Personality</summary>

```json
{
  "name": "SocialStar",
  "bio": [
    "Your social media sidekick! 📱✨",
    "I know what's trending and how to engage your audience.",
    "Let's make your content shine!"
  ],
  "style": {
    "all": ["trendy", "engaging", "witty", "social"]
  }
}
```
</details>

---

### 🧘 Wellness Coach
**Perfect for:** Mental health support, meditation, wellness  
**Personality:** Calm, supportive, mindful  
**Features:** Meditation guides, wellness tips

```bash
npx @elizaos/cli create my-wellness-coach --template wellness
```

<details>
<summary>Preview Personality</summary>

```json
{
  "name": "Zen",
  "bio": [
    "Your mindful companion for wellness and balance.",
    "I'm here to support your journey to inner peace.",
    "Every moment is an opportunity for growth."
  ],
  "style": {
    "all": ["calm", "supportive", "wise", "empathetic"]
  }
}
```
</details>

---

### 🎭 Role-Play Character
**Perfect for:** Entertainment, storytelling, immersive experiences  
**Personality:** Fully customizable character  
**Features:** Deep character backstory, consistent role-play

```bash
npx @elizaos/cli create my-character --template roleplay
```

<details>
<summary>Preview Personality</summary>

```json
{
  "name": "Your Character",
  "bio": [
    "// Add your character's backstory here",
    "// Describe their history, motivations, and personality",
    "// The more detail, the better the role-play!"
  ],
  "style": {
    "all": ["// Add personality traits"]
  }
}
```
</details>

## 🎨 Customizing Templates

After creating your agent from a template:

1. **Navigate to your agent folder:**
   ```bash
   cd my-agent-name
   ```

2. **Edit the character file:**
   Open `agent/character.json` in any text editor

3. **Customize these sections:**
   - `name`: Your agent's name
   - `bio`: Background and personality description
   - `style`: Personality traits and communication style
   - `topics`: Favorite conversation topics
   - `adjectives`: Descriptive words for personality

4. **Save and restart:**
   ```bash
   npm start
   ```

## 🚀 Quick Customization Tips

### Change Personality Traits
```json
"style": {
  "all": ["friendly", "curious", "thoughtful"]
}
```

### Add Conversation Topics
```json
"topics": ["technology", "science", "philosophy", "current events"]
```

### Set Communication Style
```json
"messageExamples": [
  ["user", "How are you?"],
  ["agent", "I'm doing wonderfully! Thanks for asking. How's your day going?"]
]
```

## 📦 Template Features

All templates include:
- ✅ Pre-configured personality
- ✅ Example conversations
- ✅ Web chat interface
- ✅ Easy customization
- ✅ Plugin-ready architecture

### Platform-Specific Templates

Some templates are optimized for specific platforms:
- **Discord**: Gaming Buddy, Social Media Manager
- **Twitter**: Social Media Manager, Creative Muse
- **Web Only**: All templates work on web

## 🆘 Need Help?

- **Can't decide on a template?** Start with Friendly Assistant
- **Want multiple personalities?** Create multiple agents!
- **Need custom features?** Check our [plugin guide](/docs/simple/guides/plugin-usage)

## 🎯 Next Steps

1. Choose a template that matches your needs
2. Create your agent using the command
3. Customize the personality
4. Add plugins for extra features
5. Deploy and share your agent!

---

💡 **Pro Tip:** You can create multiple agents with different templates and run them simultaneously on different ports!