# `@elizaos/plugin-depin`

The **`@elizaos/plugin-depin`** plugin empowers the Eliza Agent Framework with **Perception** and **Action** capabilities via **Decentralized Physical Infrastructure Networks (DePINs)**, bridging the digital intelligence of AI with the physical world.

- **DePINs as "Senses and Actuators":** Enables real-time data access from decentralized sensors and control over physical devices, making DePINs the sensory organs and actuators for Eliza agents.
- **Unlock Transformative Use Cases:** From drone delivery to smart city infrastructure and precision agriculture, this plugin extends your AI agents' potential.
- **Foundation for Sentient AI:** Facilitates contextual awareness, predictive capabilities, and goal-oriented behavior based on real-world sensory input and continuous feedback loops.

Leverage **`@elizaos/plugin-depin`** to seamlessly integrate AI agents with the real world, enabling them to **perceive, act, and learn**.

---

## Key Features

1. **Seamless IoTeX Integration:**
   - Leverages IoTeX Modular Infra to connect to a growing ecosystem of DePIN networks.
2. **Unified Data Access:**
   - Standardized interfaces allow access to diverse DePIN data sources, regardless of protocols or formats.
3. **Time-Series Data Handling:**
   - Equipped to analyze temporal patterns for predictive capabilities.
4. **Future-Proof Design:**
   - Designed to scale with the evolving DePIN and AI landscape.

---

## Configuration

### Environment Variables

Add the following to your `.env` file:

```env
SENTAI_API_KEY=your-sentai-api-key
```

### Character Configuration

Update `character.json` with the following configuration to enable the plugin:

```json
"plugins": [
    "@elizaos/plugin-depin"
]
```

This ensures that the **`@elizaos/plugin-depin`** plugin is loaded and operational within your Eliza Agent Framework, enabling seamless integration with DePIN networks and their data.

---

## Providers

### DePINScan

The **DePINScan provider** bridges the gap between your Eliza agents and decentralized physical infrastructure. By fetching and caching data from the DePINScan API, it provides actionable insights such as:

- **Daily Metrics:** Get the latest statistics on DePIN activity, including device operations and network performance.
- **Project Data:** Detailed information about individual DePIN projects:
  - **Project Identifiers:** Names and slugs for easy referencing.
  - **Token Information:** Market metrics such as token prices, market caps, and fully diluted valuations (FDV).
  - **Device Statistics:** Total devices deployed, operational costs, and earnings.
  - **Blockchain Integration:** Layer 1 chains associated with projects and their respective categories.
  - **Market Insights:** Comprehensive data on market trends and project capitalization.

---

## Actions

### DePIN Projects

The **DEPIN_PROJECTS** action empowers Eliza agents to interact with and analyze DePIN project data, enabling:

- **Token Metrics Queries:** Retrieve token prices, market capitalizations, and valuations for projects.
- **Project Comparisons:** Compare key metrics across multiple DePIN projects.
- **Filtering Capabilities:** Refine results by project categories or supported blockchain platforms.
- **Device and Revenue Analysis:** Explore statistics such as device deployment, operational costs, and revenue generation.
- **In-depth Queries:** Answer detailed questions about specific DePIN projects by leveraging the rich dataset provided by the DePINScan API.

### Sentient AI

The **SENTIENT_AI** action integrates Sentient AI APIs to provide Eliza agents with weather-related capabilities. Key functionalities include:

- **Real-Time Weather Updates:** Deliver current temperature, humidity, and general conditions for specified locations. (supported by Nubila)
- **Forecast Analysis:** Generate short- and long-term forecasts to assist in planning and decision-making. (supported by Nubila)
- **Other Actions** Sentient AI will continue to improve and add more actions based on DePIN data.

---

## Sentient AI with DePIN Integration

The **`@elizaos/plugin-depin`** plugin is a critical component in the evolution of Eliza agents into sentient systems that are aware of and responsive to their physical environments. By integrating with DePINs, this plugin enables AI agents to:

- **Perceive:** Access sensory data streams from devices across decentralized networks, including environmental sensors, location trackers, and motion detectors.
- **Act:** Influence and control connected devices in real-time, unlocking a wide array of use cases from logistics to urban management.
- **Learn:** Build predictive models and goal-oriented behaviors using continuous feedback from real-world data sources.

### Transformative Applications

From smart city infrastructure and autonomous vehicle systems to precision agriculture and environmental monitoring, the **`@elizaos/plugin-depin`** unlocks new frontiers in AI development. By merging decentralized infrastructure with AI-driven perception and action, this plugin empowers agents to act not just in virtual spaces but in the physical world.

With its **future-proof design** and seamless integration capabilities, the **`@elizaos/plugin-depin`** is an essential tool for developers looking to push the boundaries of AI and decentralized systems.

Start building the next generation of AI-powered applications with **`@elizaos/plugin-depin`** and redefine what’s possible for intelligent agents in the real world.