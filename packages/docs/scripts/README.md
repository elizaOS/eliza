# Documentation Scripts

This directory contains various scripts used to automate tasks, generate content, and maintain the Eliza documentation website (`packages/docs`).

## Script Descriptions:

- **`deepsearch.py`**: A Python script likely implementing advanced search functionalities for the documentation. This could involve indexing content or integrating with a search service.

- **`fetch-news.sh`**: A shell script responsible for fetching news content. It likely retrieves data from external sources (e.g., a news feed or API) and prepares it for inclusion in the `/news` section of the documentation. This script is referenced by the `update-news.sh` script and the `update-news.yml` GitHub workflow.

- **`get-changelog.py`**: A Python script designed to extract and format changelog information. This is probably used to automatically generate or update changelog sections within the documentation from commit history or release notes.

- **`plugin_summary_prompt.txt`**: A text file containing a prompt template, likely for an AI model (LLM). This prompt guides the AI in generating summaries for plugins, which can then be used in the documentation.

- **`summarize.sh`**: A shell script that performs summarization tasks. This might work in conjunction with `plugin_summary_prompt.txt` and an LLM to generate summaries for documentation content or news articles.

- **`update-news.sh`**: This shell script (referenced in the `update-news.yml` workflow) automates the updating of news files in `packages/docs/news`. It downloads new markdown files from a source URL and updates the `repomix.config.json` to include these new files for context generation. See the content of [`update-news.sh`](../update-news.sh) for more details.

- **`update-partner-pages.js`**: A Node.js script that automates the updating of partner pages within the documentation. It might fetch data from a source and regenerate or modify Markdown files for individual partners.

- **`update-partners-from-csv.js`**: A Node.js script that specifically updates partner information from a CSV file. This allows for easier management of partner data, which is then reflected in the documentation.

- **`update-registry.js`**: A Node.js script likely responsible for updating some form of registry information displayed in the documentation. This could be related to plugins, packages, or other versioned items.

These scripts play a vital role in keeping the documentation up-to-date, consistent, and informative by automating many of the content generation and maintenance processes.
