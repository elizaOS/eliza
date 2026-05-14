# Specifying Test Categories

When running tests, you can use the optional `--test-category` parameter to define which categories of tests to execute. You can provide multiple categories by separating them with spaces. If no category is specified, all available tests will run by default.

## Available Test Groups

You can specify a broad category (test group) to run multiple related tests at once (you can also use `bfcl test-categories` command to see this list):

- `all`: All test categories.
  - This is the default option if no test category is provided.
  - This includes all test categories, including non-scoring yet useful categories like `format_sensitivity`.
- `all_scoring`: All scoring test categories that will affect the overall accuracy score.
- `agentic`: All agentic test categories (a superset that currently includes all `memory` and `web_search` categories).
- `multi_turn`: All multi-turn test categories.
- `single_turn`: All single-turn test categories.
- `live`: All user-contributed live test categories.
- `non_live`: All non-user-contributed test categories (the opposite of `live`).
- `python`: Tests specific to Python code.
- `non_python`: Tests for code in languages other than Python, such as Java and JavaScript.
- `memory`: All memory-based test categories (e.g., `memory_kv`, `memory_vector`, `memory_rec_sum`).
- `web_search`: All web-search test categories.

## Available Individual Test Categories

If you prefer more granular control, you can specify individual categories:

- `simple_python`: Simple Python function calls. This is part of the `non-live simple` category on the leaderboard.
- `simple_java`: Simple Java function calls. This is part of the `non-live simple` category on the leaderboard.
- `simple_javascript`: Simple JavaScript function calls. This is part of the `non-live simple` category on the leaderboard.
- `parallel`: Multiple function calls in parallel.
- `multiple`: Multiple function calls in sequence.
- `parallel_multiple`: Multiple function calls in parallel and in sequence.
- `irrelevance`: Function calls with irrelevant function documentation.
- `live_simple`: User-contributed simple function calls.
- `live_multiple`: User-contributed multiple function calls in sequence.
- `live_parallel`: User-contributed multiple function calls in parallel.
- `live_parallel_multiple`: User-contributed multiple function calls in parallel and in sequence.
- `live_irrelevance`: User-contributed function calls with irrelevant function documentation.
- `live_relevance`: User-contributed function calls with relevant function documentation.
- `multi_turn_base`: Base entries for multi-turn function calls.
- `multi_turn_miss_func`: Multi-turn function calls with missing function.
- `multi_turn_miss_param`: Multi-turn function calls with missing parameter.
- `multi_turn_long_context`: Multi-turn function calls with long context.
- `memory_kv`: Tests reading from and writing to a key-value memory backend.
- `memory_vector`: Tests reading from and writing to a vector-database memory backend.
- `memory_rec_sum`: Tests reading from and writing to a recursive-summarization memory backend.
- `web_search_base`: Base entries for web-search calls.
- `web_search_no_snippet`: Web-search calls where search-engine snippets are withheld, forcing the model to fetch and read webpages.
- `format_sensitivity`: Various system prompt formats to test the format sensitivity of the model.
  - This only works for the prompting mode models that rely on the default system prompt to do tool calls.
