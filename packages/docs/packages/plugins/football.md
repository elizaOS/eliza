# @elizaos/plugin-football

A plugin providing live football match data and league standings integration for ElizaOS agents.

## Description

The Football plugin integrates with the [Football-Data.org API](https://www.football-data.org/) to enable ElizaOS agents to fetch live football match information and league standings. It includes actions and utilities to provide real-time football data in conversations.

## Installation

To install the plugin, use the following command:

```bash
pnpm install @elizaos/plugin-football
```

## Features

### 1. Live Match Data

- **Action**: `fetchMatchAction`
    - Retrieves live football match data, including:
        - Teams
        - Scores
        - Game events
    - Provides real-time updates for ongoing matches.

### 2. League Standings

- **Action**: `fetchStandingsAction`
    - Fetches league standings for a specified competition, including:
        - Team rankings
        - Points
        - Goals scored
        - Other league statistics.

### 3. Flexible Integration

- Extendable for additional football data, such as:
    - Player statistics
    - Match schedules
    - Historical match data.

## API Key Configuration

To use this plugin, you need an API key from [Football-Data.org](https://www.football-data.org/).

1. Register and obtain your API key from Football-Data.org.
2. Add the API key to your `.env` file:

    ```env
    FOOTBALL_API_KEY=your_api_key_here
    ```

The plugin will use this key to authenticate requests.

## Usage Examples

### `fetchMatchAction`

**Description**: Retrieves live match data.

**Code Example**:

```javascript
import { fetchMatchAction } from "@elizaos/plugin-football";

const result = await fetchMatchAction.handler(runtime, message, state);
console.log(result);
```

**Sample Output**:

```json
{
    "matches": [
        {
            "homeTeam": { "name": "Chelsea" },
            "awayTeam": { "name": "Arsenal" },
            "score": {
                "fullTime": { "homeTeam": 1, "awayTeam": 2 }
            }
        }
    ]
}
```

### `fetchStandingsAction`

**Description**: Fetches league standings for a specific competition.

**Code Example**:

```javascript
import { fetchStandingsAction } from "@elizaos/plugin-football";

const result = await fetchStandingsAction.handler(runtime, message, state);
console.log(result);
```

**Sample Output**:

```json
{
    "standings": [
        {
            "table": [
                {
                    "position": 1,
                    "team": { "name": "Manchester City" },
                    "points": 45
                },
                { "position": 2, "team": { "name": "Arsenal" }, "points": 42 }
            ]
        }
    ]
}
```

## Development

### Steps to Build and Test

1. Clone the repository:

    ```bash
    git clone https://github.com/elizaOS/eliza.git
    ```

2. Navigate to the `plugin-football` directory and install dependencies:

    ```bash
    cd packages/plugin-football
    pnpm install
    ```

3. Build the plugin:

    ```bash
    pnpm run build
    ```

4. Run linting:

    ```bash
    pnpm run lint
    ```

5. Test the plugin:

    ```bash
    pnpm vitest src/tests/match-action.test.ts
    pnpm vitest src/tests/fetch-standings-action.test.ts
    ```

## Dependencies

This plugin relies on the following dependency:

- `@elizaos/core: workspace:*`

## Future Enhancements

### Expanded Football Data Features

- Player statistics
- Match schedules and fixtures
- Team information and histories
- Historical match data

### Advanced League Tracking

- Real-time updates for all supported leagues
- Integration with more competitions (e.g., Champions League, World Cup)

### Customizable Output

- Improved data formatting for conversational outputs
- Support for additional localization options

### Integration Improvements

- Enhanced API error handling
- Caching for frequently accessed data
- Increased rate-limit compliance for the Football-Data.org API

### Developer Tools

- Sample applications for plugin usage
- Test suites for advanced football scenarios
- Examples for extending plugin functionality

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Football-Data.org](https://www.football-data.org/documentation/quickstart/) Official Football-Data platform API

Special thanks to:

- Special thanks to [Football-Data.org](https://www.football-data.org/) for providing the API that powers this plugin.
- The Eliza Core development team.
- The Eliza community for their contributions and feedback

For more information about Football-Data integration capabilities:

- [Football-Data API Documentation](https://www.football-data.org/documentation/quickstart)
- [Football-Data Developer Portal](https://www.football-data.org/documentation/api)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
