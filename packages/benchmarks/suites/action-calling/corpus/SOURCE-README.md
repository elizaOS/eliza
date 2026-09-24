---
license: apache-2.0
task_categories:
- text-generation
- question-answering
- feature-extraction
language:
- en
configs:
- config_name: func_calling_singleturn
  data_files: func-calling-singleturn.json
  default: true
- config_name: func_calling
  data_files: func-calling.json
- config_name: glaive_func_calling
  data_files: glaive-function-calling-5k.json
- config_name: json_mode_agentic
  data_files: json-mode-agentic.json
- config_name: json_mode_singleturn
  data_files: json-mode-singleturn.json
tags:
- tool-use,
- function-calling
- agentic
- synthetic-data
---

![image/png](https://cdn-uploads.huggingface.co/production/uploads/6317aade83d8d2fd903192d9/nNQdNcHw9tvQw0AIPGW_i.png)

# Hermes Function-Calling V1

This dataset is the compilation of structured output and function calling data used in the Hermes 2 Pro series of models.

This repository contains a structured output dataset with function-calling conversations, json-mode, agentic json-mode and structured extraction samples, designed to train LLM models in performing function calls and returning structured output based on natural language instructions. The dataset features various conversational scenarios where AI agents are required to interpret queries and execute appropriate single or multiple function calls.

The synthetic data generation was led by @interstellarninja in collaboration with @NousResearch, @teknium, @THEODOROS and many others who provided guidance.

## Hermes Function Calling Standard

Hermes Function-calling Standard enables creation of LLM agents that are capable of executing API calls directly from user instructions. For instance, when asked to "find a flight from New York to Los Angeles for next Friday," a function-calling agent can interpret the request, generate the necessary function call (e.g., `search_flights`), and return the results. These agents significantly enhance the utility of AI by enabling direct interactions with APIs, making them invaluable in digital assistants across various domains.

For a complete useage guide of models trained on this data, see our github repo: https://github.com/NousResearch/Hermes-Function-Calling

## Repository Structure

There are 5 datasets that comprise the datamix,

**func-calling-singleturn.json** - Single turn function calls

**func-calling.json** - Multi-turn conversation function calls 

**glaive-function-calling-5k.json** - Updated and cleaned Glaive Function Calling 5k dataset by Glaive AI

**json-mode-agentic.json** - Advanced JSON structured output samples

**json-mode-singleturn.json** - Single turn JSON structured output samples

The dataset has the following configs, used to load each file:

- ```func_calling_singleturn```
- ```func_calling```
- ```glaive_func_calling```
- ```json_mode_agentic```
- ```json_mode_singleturn```

### Inference Example Output

Here's an example of the inference output:

```
<|im_start|>user
Fetch the stock fundamentals data for Tesla (TSLA)<|im_end|>
<|im_start|>assistant
<tool_call>
{"name": "get_stock_fundamentals", "arguments": {"symbol": "TSLA"}}
</tool_call><|im_end|>
<|im_start|>tool
<tool_response>
{"name": "get_stock_fundamentals", "content": {"symbol": "TSLA", "company_name": "Tesla, Inc.", "sector": "Consumer Cyclical", "industry": "Auto Manufacturers", "market_cap": 611384164352, "pe_ratio": 49.604652, "pb_ratio": 9.762013, "dividend_yield": null, "eps": 4.3, "beta": 2.427, "52_week_high": 299.29, "52_week_low": 152.37}}
</tool_response>
<|im_end|>
<|im_start|>assistant
The stock fundamentals data for Tesla (TSLA) are as follows:
- **Symbol**: TSLA
- **Company Name**: Tesla, Inc.
- **Sector**: Consumer Cyclical
- **Industry**: Auto Manufacturers
- **Market Capitalization**: $566,160,130,480
- **Forward Price-to-Earnings Ratio (PE Ratio)**: 42.73
- **Price-to-Book Ratio (PB Ratio)**: 9.04
- **Dividend Yield**: N/A
- **Trailing Earnings Per Share (EPS)**: $4.3
- **Beta Value of the Stock**: 2.42
- **52-Week High Price of the Stock**: $299.29
- **52-Week Low Price of the Stock**: $152.37
This information provides a snapshot of Tesla's financial position and performance based on the fundamental data obtained from the yfinance API. It shows that Tesla has a substantial market capitalization and a relatively high P/E and P/B ratio compared to other stocks in its industry. The company does not pay a dividend at the moment, which is reflected by a 'Dividend Yield' of 'None'. The Beta value indicates that Tesla's stock has a moderate level of volatility relative to the market. The 52-week high and low prices give an idea of the stock's range over the past year. This data can be useful when assessing investment opportunities and making investment decisions.
```

### Hermes-2 Pro Prompt Format for Function Calling
Our model was trained on specific system prompts and structures for Function Calling.

You should use the system role with this message, followed by a function signature json as this example shows here.
```
<|im_start|>system
You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools: <tools> [{"type": "function", "function": {"name": "get_stock_fundamentals", "description": "Get fundamental data for a given stock symbol using yfinance API.", "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}}}] </tools> Use the following pydantic model json schema for each tool call you will make: {"title": "FunctionCall", "type": "object", "properties": {"name": {"title": "Name", "type": "string"}, "arguments": {"title": "Arguments", "type": "object"}}, "required": ["name", "arguments"]} For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": <function-name>, "arguments": <args-dict>}
</tool_call><|im_end|>
```
To complete the function call, create a user prompt that follows the above system prompt, like so:
```
<|im_start|>user
Fetch the stock fundamentals data for Tesla (TSLA)<|im_end|>
```
The model will then generate a tool call, which your inference code must parse, and plug into a function
```
<|im_start|>assistant
<tool_call>
{"name": "get_stock_fundamentals", "arguments": {"symbol": "TSLA"}}
</tool_call><|im_end|>
```
Once you parse the tool call, call the api and get the returned values for the call, and pass it back in as a new role, tool like so:
```
<|im_start|>tool
<tool_response>
{"name": "get_stock_fundamentals", "content": {"symbol": "TSLA", "company_name": "Tesla, Inc.", "sector": "Consumer Cyclical", "industry": "Auto Manufacturers", "market_cap": 611384164352, "pe_ratio": 49.604652, "pb_ratio": 9.762013, "dividend_yield": null, "eps": 4.3, "beta": 2.427, "52_week_high": 299.29, "52_week_low": 152.37}}
</tool_response>
<|im_end|>
```
The assistant will then read in that data from the function's response, and generate a natural language response:
```
<|im_start|>assistant
The stock fundamentals data for Tesla (TSLA) are as follows:
- **Symbol**: TSLA
- **Company Name**: Tesla, Inc.
- **Sector**: Consumer Cyclical
- **Industry**: Auto Manufacturers
- **Market Capitalization**: $566,160,130,480
- **Forward Price-to-Earnings Ratio (PE Ratio)**: 42.73
- **Price-to-Book Ratio (PB Ratio)**: 9.04
- **Dividend Yield**: N/A
- **Trailing Earnings Per Share (EPS)**: $4.3
- **Beta Value of the Stock**: 2.42
- **52-Week High Price of the Stock**: $299.29
- **52-Week Low Price of the Stock**: $152.37

This information provides a snapshot of Tesla's financial position and performance based on the fundamental data obtained from the yfinance API. It shows that Tesla has a substantial market capitalization and a relatively high P/E and P/B ratio compared to other stocks in its industry. The company does not pay a dividend at the moment, which is reflected by a 'Dividend Yield' of 'None'. The Beta value indicates that Tesla's stock has a moderate level of volatility relative to the market. The 52-week high and low prices give an idea of the stock's range over the past year. This data can be useful when assessing investment opportunities and making investment decisions.<|im_end|>
```
### Prompt Format for JSON Mode / Structured Outputs
Our model was also trained on a specific system prompt for Structured Outputs, which should respond with only a json object response, in a specific json schema.

Your schema can be made from a pydantic object using our codebase, with the standalone script jsonmode.py available here: https://github.com/NousResearch/Hermes-Function-Calling/tree/main
```
<|im_start|>system
You are a helpful assistant that answers in JSON. Here's the json schema you must adhere to:\n<schema>\n{schema}\n</schema><|im_end|>
```
Given the {schema} that you provide, it should follow the format of that json to create it's response, all you have to do is give a typical user prompt, and it will respond in JSON.

## Dataset Structure
The dataset follows a sharegpt structure. This means it is a list of dictionaries, with each dictionary containing a new list of dicts called conversations. Each turn in a conversation has two dictionaries, a "from" field, which denotes the role of that turn, and a "value" field which contains the actual text.

### Tool-use with API response:
```json
{
  "id": "753d8365-0e54-43b1-9514-3f9b819fd31c",
  "conversations": [
    {
      "from": "system",
      "value": "You are a function calling AI model. You are provided with function signatures within <tools> </tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions.\n<tools>\n[{'type': 'function', 'function': {'name': 'search_flights', 'description': 'Searches for flights based on departure and destination cities, dates, class, and other preferences.', 'parameters': {'type': 'object', 'properties': {'departure_city': {'type': 'string', 'description': 'The city from which the flight will depart.'}, 'destination_city': {'type': 'string', 'description': 'The destination city for the flight.'}, 'departure_date': {'type': 'string', 'description': 'The departure date for the flight.', 'format': 'date'}, 'return_date': {'type': 'string', 'description': 'The return date for the flight.', 'format': 'date'}, 'class': {'type': 'string', 'description': 'The class of the flight ticket.', 'enum': ['economy', 'business', 'first']}, 'flexible_cancellation': {'type': 'boolean', 'description': 'Indicates if the search should filter for flights with flexible cancellation policies.'}}, 'required': ['departure_city', 'destination_city', 'departure_date', 'return_date', 'class']}}}]\n</tools>\nFor each function call return a json object with function name and arguments within <tool_call> </tool_call> tags with the following schema:\n<tool_call>\n{'arguments': <args-dict>, 'name': <function-name>}\n</tool_call>\n"
    },
    {
      "from": "human",
      "value": "I'm planning a kayaking trip and looking to book flights from Los Angeles to Auckland. My departure is scheduled for July 10th, 2023, and I intend to return on July 24th, 2023. I would prefer to travel in economy class and would also like the option to have flexible cancellation policies for the tickets due to the uncertain nature of outdoor activities. Could you please search for flights that meet these criteria and provide me with the available options?"
    },
    {
      "from": "gpt",
      "value": "<tool_call>\n{'arguments': {'departure_city': 'Los Angeles', 'destination_city': 'Auckland', 'departure_date': '2023-07-10', 'return_date': '2023-07-24', 'class': 'economy', 'flexible_cancellation': True}, 'name': 'search_flights'}\n</tool_call>\n"
    },
    {
      "from": "tool",
      "value": "<tool_response>\n{\"name\": \"search_flights\", \"content\": {\"flights\": [{\"flight_number\": \"AA118\", \"airline\": \"American Airlines\", \"departure_airport\": \"LAX\", \"departure_city\": \"Los Angeles\", \"departure_date\": \"2023-07-10T08:00:00Z\", \"departure_terminal\": \"4\", \"arrival_airport\": \"AKL\", \"arrival_city\": \"Auckland\", \"arrival_date\": \"2023-07-11T14:25:00Z\", \"arrival_terminal\": \"I\", \"duration\": \"17h 25m\", \"class\": \"Economy\", \"price\": \"$950\", \"flexible_cancellation\": true}, {\"flight_number\": \"UA796\", \"airline\": \"United Airlines\", \"departure_airport\": \"LAX\", \"departure_city\": \"Los Angeles\", \"departure_date\": \"2023-07-10T11:30:00Z\", \"departure_terminal\": \"7\", \"arrival_airport\": \"AKL\", \"arrival_city\": \"Auckland\", \"arrival_date\": \"2023-07-11T18:30:00Z\", \"arrival_terminal\": \"I\", \"duration\": \"16h 0m\", \"class\": \"Economy\", \"price\": \"$975\", \"flexible_cancellation\": true}, {\"flight_number\": \"NZ6\", \"airline\": \"Air New Zealand\", \"departure_airport\": \"LAX\", \"departure_city\": \"Los Angeles\", \"departure_date\": \"2023-07-10T21:00:00Z\", \"departure_terminal\": \"B\", \"arrival_airport\": \"AKL\", \"arrival_city\": \"Auckland\", \"arrival_date\": \"2023-07-12T05:20:00Z\", \"arrival_terminal\": \"I\", \"duration\": \"13h 20m\", \"class\": \"Economy\", \"price\": \"$1020\", \"flexible_cancellation\": true}], \"return_flights\": [{\"flight_number\": \"AA117\", \"airline\": \"American Airlines\", \"departure_airport\": \"AKL\", \"departure_city\": \"Auckland\", \"departure_date\": \"2023-07-24T14:10:00Z\", \"departure_terminal\": \"I\", \"arrival_airport\": \"LAX\", \"arrival_city\": \"Los Angeles\", \"arrival_date\": \"2023-07-24T06:00:00Z\", \"arrival_terminal\": \"4\", \"duration\": \"12h 50m\", \"class\": \"Economy\", \"price\": \"$950\", \"flexible_cancellation\": true}, {\"flight_number\": \"UA797\", \"airline\": \"United Airlines\", \"departure_airport\": \"AKL\", \"departure_city\": \"Auckland\", \"departure_date\": \"2023-07-24T19:15:00Z\", \"departure_terminal\": \"I\", \"arrival_airport\": \"LAX\", \"arrival_city\": \"Los Angeles\", \"arrival_date\": \"2023-07-24T10:15:00Z\", \"arrival_terminal\": \"7\", \"duration\": \"11h 0m\", \"class\": \"Economy\", \"price\": \"$975\", \"flexible_cancellation\": true}, {\"flight_number\": \"NZ5\", \"airline\": \"Air New Zealand\", \"departure_airport\": \"AKL\", \"departure_city\": \"Auckland\", \"departure_date\": \"2023-07-24T19:30:00Z\", \"departure_terminal\": \"I\", \"arrival_airport\": \"LAX\", \"arrival_city\": \"Los Angeles\", \"arrival_date\": \"2023-07-24T10:30:00Z\", \"arrival_terminal\": \"B\", \"duration\": \"12h 0m\", \"class\": \"Economy\", \"price\": \"$1020\", \"flexible_cancellation\": true}]}}\n</tool_response>\n"
    },
    {
      "from": "gpt",
      "value": "Here are the available flight options with flexible cancellation policies for your kayaking trip from Los Angeles to Auckland:\n\n**Outbound Flights (Los Angeles to Auckland):**\n1. **American Airlines AA118**\n   - Departure: July 10, 2023, 8:00 AM from LAX Terminal 4\n   - Arrival: July 11, 2023, 2:25 PM at AKL Terminal I\n   - Duration: 17h 25m\n   - Price: $950\n\n2. **United Airlines UA796**\n   - Departure: July 10, 2023, 11:30 AM from LAX Terminal 7\n   - Arrival: July 11, 2023, 6:30 PM at AKL Terminal I\n   - Duration: 16h 0m\n   - Price: $975\n\n3. **Air New Zealand NZ6**\n   - Departure: July 10, 2023, 9:00 PM from LAX Terminal B\n   - Arrival: July 12, 2023, 5:20 AM at AKL Terminal I\n   - Duration: 13h 20m\n   - Price: $1020\n\n**Return Flights (Auckland to Los Angeles):**\n1. **American Airlines AA117**\n   - Departure: July 24, 2023, 2:10 PM from AKL Terminal I\n   - Arrival: July 24, 2023, 6:00 AM at LAX Terminal 4\n   - Duration: 12h 50m\n   - Price: $950\n\n2. **United Airlines UA797**\n   - Departure: July 24, 2023, 7:15 PM from AKL Terminal I\n   - Arrival: July 24, 2023, 10:15 AM at LAX Terminal 7\n   - Duration: 11h 0m\n   - Price: $975\n\n3. **Air New Zealand NZ5**\n   - Departure: July 24, 2023, 7:30 PM from AKL Terminal I\n   - Arrival: July 24, 2023, 10:30 AM at LAX Terminal B\n   - Duration: 12h 0m\n   - Price: $1020\n\nAll the listed prices are in economy class with flexible cancellation policies. Please review the options and let me know if you would like to proceed with booking any of these flights or if you need further assistance."
    }
  ],
  "category": "E-commerce Platforms",
  "subcategory": "Kayak",
  "task": "Flight Search"
}
```

### Structured extraction with function-calling:
```json
{
  "id": "afba1f0c-3212-467d-8594-d72a06da4d05",
  "conversations": [
    {
      "from": "system",
      "value": "You are an expert structured information extraction AI model. You will be provided with documents to extract information from. You are also provided with the json schema to output extracted information in the function signatures within XML tags <tools></tools>. Don't make assumptions about what values to plug into json schema. \n<tools>\n[{\"type\": \"function\", \"function\": {\"name\": \"ExpertQAExtractor\", \"description\": \"Extracts a list of questions that ask how a concept or information from the document can be applied to a real-world situation. These assess ability to apply knowledge.\", \"parameters\": {\"type\": \"object\", \"properties\": {\"application_questions\": {\"type\": \"array\", \"items\": {\"type\": \"string\"}}}, \"required\": [\"application_questions\"]}}}]\n</tools>\nFor each extraction function call return a json object with function name and arguments followed by a <tool_call> tag with the following schema:\n<tool_call>\n{'arguments': <args-dict>, 'name': <function-name>}\n</tool_call>"
    },
    {
      "from": "human",
      "value": "Can you help me extract queries from the following passage <passage> : A directed graph. \n weighted, by the way. If a pair of vertices in such a graph is attached \"both ways,\" then each of the two edges will have its own weight. \n Washington, DC \n Fredericksburg \n Richmond \n Virginia Beach \n 50 \n 60 100 \n 150 \n Figure 5.3: A weighted (and undirected) graph. \n**adjacent.** If two vertices have an edge between them, they are said to be adjacent. \n**connected.** The word **connected** has two meanings: it applies both to pairs of vertices and to entire graphs. We say that two vertices are connected if there is at least one path between them. Each vertex is therefore \"reachable\" from the other. In Figure 5.1, President and actor are connected, but Ford's Theatre and Civil War are not. \"Connected\" is also used to describe entire graphs, if _every_ node can be reached from all others. It's easy to see that Fig\n90 CHAPTER 5. STRUCTURES \n ure 5.3 is a connected graph, whereas Figure 5.1 is not (because Civil War and Gettysburg are isolated from the other nodes). It's not always trivial to determine whether a graph is connected, however: imagine a tangled morass of a million vertices, with ten million edges, and having to figure out whether or not every vertex is reachable from every other. (And if that seems unrealistically large, consider Facebook, which has over a billion nodes.) \n**degree.** A vertex's degree is simply the number of edges that connect to it. Virginia Beach has degree 2, and Fredericksburg \n3. In the case of a directed graph, we sometimes distinguish between the number of incoming arrows a vertex has (called its **in-degree** ) and the number of outgoing arrows (the **out- degree** ). Muhammad Ali had a higher out-degree (3) than in-degree (1) since he won most of the time. \n**cycle.** A cycle is a path that begins and ends at the same vertex.^2 In Figure 5.3, Richmond-to-Virginia Beach-to-Fredericksburgto-Richmond is a cycle. Any loop is a cycle all by itself. For directed graphs, the entire loop must comprise edges in the \"forward\" direction: no fair going backwards. In Figure 5.2, Frazier-to-Ali-to-Foreman-to-Frazier is a cycle, as is the simpler Ali-to-Frazier-to-Ali. \n**DAG (directed, acyclic graph).** One common use of graphs is to represent flows of dependencies, for instance the prerequisites that different college courses have for one another. Another example is project management workflows: the tasks needed to complete a project become vertices, and then the dependencies they have on one another become edges. The graph in Figure 5.4 shows the steps in making a batch of brownies, and how these steps depend on each other. The eggs have to be cracked before the ingredients can be mixed, \n(^2) We'll also say that a cycle can't repeat any edges or vertices along the way, so that it can't go back and forth repeatedly and pointlessly between two adjacent nodes. Some mathematicians call this a **simple cycle** to distinguish it from the more general **cycle** , but we'll just say that no cycles can repeat like this. \n5.1. GRAPHS 91 \n and the oven has to be preheated before baking, but the pan can be greased any old time, provided that it's done before pouring the brown goop into it. \n mix ingredients \n pour brown stuff in bowl \n crack two eggs measure 2 tbsp oil \n preheat oven \n bake for 30 mins \n grease pan \n pour into pan \n cool \n enjoy! \n Figure 5.4: A DAG. \n A graph of dependencies like this must be both directed and acyclic , or it wouldn't make sense. Directed, of course, means that task X can require task Y to be completed before it, without the reverse also being true. If they both depended on each other, we'd have an infinite loop, and no brownies could ever get baked! Acyclic means that no kind of cycle can exist in the graph, even one that goes through multiple vertices. Such a cycle would again result in an infinite loop, making the project hopeless. Imagine if there were an arrow from bake for 30 mins back to grease pan in Figure 5.4. Then, we'd have to grease the pan before pouring the goop into it, and we'd have to pour the goop before baking, but we'd also have to bake before greasing the pan! We'd be stuck right off the bat: there'd be no way to complete any of those tasks since they'd all indirectly depend on each other. A graph that is both directed and acyclic (and therefore free of these problems) is sometimes called a DAG for short. \n92 CHAPTER 5. STRUCTURES \n**Spatial positioning** \nOne important thing to understand about graphs is which aspects of a diagram are relevant. Specifically, _the spatial positioning of the vertices doesn't matter._ In Figure 5.2 we drew Muhammad Ali in the mid-upper left, and Sonny Liston in the extreme upper right. But this was an arbitrary choice, and irrelevant. More specifically, this isn't part of the information the diagram claims to represent. We could have positioned the vertices differently, as in Figure 5.5, and had _the same graph_. In both diagrams, there are the same vertices, and the same edges between them (check me). Therefore, these are mathematically the same graph. \nGeorge Foreman Sonny Liston (^) Muhammad Ali Joe Frazier Figure 5.5: A different look to **the same graph as Figure 5.2**. This might not seem surprising for the prize fighter graph, but for graphs like the MapQuest graph, which actually represent physical locations, it can seem jarring. In Figure 5.3 we could have drawn Richmond north of Fredericksburg, and Virginia Beach on the far west side of the diagram, and still had the same graph, provided that all the nodes and links were the same. Just remember that the spatial positioning is designed for human convenience, and isn't part of the mathematical information. It's similar to how there's no order to the elements of a set, even though when we specify a set extensionally, we have to list them in _some_ order to avoid writing all the element names on top of each other. On a graph diagram, we have to draw each vertex _somewhere_ , but where we put it is simply aesthetic. \n5.1. GRAPHS 93 \n**Relationship to sets** \nWe seem to have strayed far afield from sets with all this graph stuff. But actually, there are some important connections to be made to those original concepts. Recall the wizards set A from chapter 3 that we extended to contain { Harry, Ron, Hermione, Neville }. Now consider the following endorelation on A: \n (Harry, Ron) (Ron, Harry) (Ron, Hermione) (Ron, Neville) (Hermione, Hermione) (Neville, Harry) \nThis relation, and all it contains, is represented faithfully by the graph in Figure 5.6. The elements of A are the vertices of course, and each ordered pair of the relation is reflected in an edge of the graph. Can you see how _exactly_ the same information is represented by both forms? \n Hermione \n Ron Neville \n Harry \n Figure 5.6: A graph depicting a endorelation. \nFigure 5.6 is a directed graph, of course. What if it were an undirected graph? The answer is that the corresponding relation would be _symmetric_. An undirected graph implies that if there's an edge between two vertices, it goes \"both ways.\" This is really identical to saying a relation is symmetric: if an (x, y) is in the relation, then the corresponding (y, x) must also be. An example is Figure 5.7, which depicts the following symmetric relation: \n94 CHAPTER 5. STRUCTURES \n (Harry, Ron) (Ron, Harry) (Ron, Hermione) (Hermione, Ron) (Harry, Harry) (Neville, Neville) \n Harry Ron \n Hermione Neville \n Figure 5.7: A graph depicting a symmetric endorelation. \nNotice how the loops (edges from a node back to itself) in these diagrams represent ordered pairs in which both elements are the same. \nAnother connection between graphs and sets has to do with partitions. Figure 5.7 was not a connected graph: Neville couldn't be reached from any of the other nodes. Now consider: isn't a graph like this similar in some ways to a _partition_ of A -- namely, this one? \n { Harry, Ron, Hermione } and { Neville }. \nWe've simply partitioned the elements of A into the groups that are connected. If you remove the edge between Harry and Ron in that graph, you have: \n { Harry }, { Ron, Hermione }, and { Neville }. \nThen add one between Hermione and Neville, and now you have: \n5.1. GRAPHS 95 \n { Harry } and { Ron, Hermione, Neville }. \nIn other words, the \"connectedness\" of a graph can be represented precisely as a partition of the set of vertices. Each connected subset is in its own group, and every vertex is in one and only one group: therefore, these isolated groups are mutually exclusive and collectively exhaustive. Cool. \n**Graph traversal** \nIf you had a long list -- perhaps of phone numbers, names, or purchase orders -- and you needed to go through and do something to each element of the list -- dial all the numbers, scan the list for a certain name, add up all the orders -- it'd be pretty obvious how to do it. You just start at the top and work your way down. It might be tedious, but it's not confusing. \nIterating through the elements like this is called **traversing** the data structure. You want to make sure you encounter each element once (and only once) so you can do whatever needs to be done with it. It's clear how to traverse a list. But how to traverse a graph? There is no obvious \"first\" or \"last\" node, and each one is linked to potentially many others. And as we've seen, the vertices might not even _be_ fully connected, so a traversal path through all the nodes might not even exist. \nThere are two different ways of traversing a graph: breadth-first, and depth-first. They provide different ways of exploring the nodes, and as a side effect, each is able to discover whether the graph is connected or not. Let's look at each in turn. \n**Breadth-first traversal** \nWith **breadth-first traversal** , we begin at a starting vertex (it doesn't matter which one) and explore the graph cautiously and delicately. We probe equally deep in all directions, making sure we've looked a little ways down each possible path before exploring each of those paths a little further. \n96 CHAPTER 5. STRUCTURES \nTo do this, we use a very simple data structure called a **queue**. A queue is simply a list of nodes that are waiting in line. (In Britain, I'm told, instead of saying \"line up\" at the sandwich shop, they say \"queue up.\") When we enter a node into the queue at the tail end, we call it **enqueueing** the node, and when we remove one from the front, we call it **dequeueing** the node. The nodes in the middle patiently wait their turn to be dealt with, getting closer to the front every time the front node is dequeued. \nAn example of this data structure in action is shown in Figure 5.8. Note carefully that we always insert nodes at one end (on the right) and remove them from the _other_ end (the left). This means that the first item to be enqueued (in this case, the triangle) will be the first to be dequeued. \"Calls will be answered in the order they were received.\" This fact has given rise to another name for a queue: a \" **FIFO** ,\" which stands for \"first-in-first-out.\" \n Start with an empty queue: | Enqueue a triangle, and we have: |^ Enqueue a star, and we have: |^ Enqueue a heart, and we have: |^ Dequeue the triangle, and we have: | Enqueue a club, and we have: | Dequeue the star, and we have: | Dequeue the heart, and we have: | Dequeue the club. We're empty again: | \nFigure 5.8: A queue in action. The vertical bar marks the \"front of the line,\" and the elements are waiting to be dequeued in order from left to right. \nNow here's how we use a queue to traverse a graph breadth-first. We're going to start at a particular node, and put all of its adjacent nodes into a queue. This makes them all safely \"wait in line\" until we get around to exploring them. Then, we repeatedly take the first node in line, do whatever we need to do with it, and then put all of _its_ adjacent nodes in line. We keep doing this until the queue is empty. \n5.1. GRAPHS 97 \nNow it might have occurred to you that we can run into trouble if we encounter the same node multiple times while we're traversing. This can happen if the graph has a cycle: there will be more than one path to reach some nodes, and we could get stuck in an infinite loop if we're not careful. For this reason, we introduce the concept of **marking** nodes. This is kind of like leaving a trail of breadcrumbs: if we're ever about to explore a node, but find out it's marked, then we know we've already been there, and it's pointless to search it again. \nSo there </passage>"
    },
    {
      "from": "gpt",
      "value": "<tool_call>\\n{\"arguments\": {\"queries\": ['How can the concept of graph traversal be applied to real-world situations, such as project management workflows or social networks?', 'Can you think of any other real-world scenarios where understanding and effectively using spatial positioning in a graph would be important?', 'In what ways can the concept of marking nodes be useful in problem-solving or decision-making processes?'], \"name\": \"ExpertQAExtractor\"}}\\n</tool_call>"
    }
  ],
  "category": "Information Extraction",
  "subcategory": "Json Schema",
  "task": "Structured json schema extaction with function calling"
}
```

### JSON-mode with pydantic JSON schema
```json
{
  "id": "57aa5f1b-6af3-42b8-9598-d48540277354",
  "conversations": [
    {
      "from": "system",
      "value": "You are a helpful assistant that answers in JSON. Here's the json schema you must adhere to:\n<schema>\n{'title': 'MovieDatabaseEntry', 'type': 'object', 'properties': {'movieId': {'title': 'Movie ID', 'type': 'string'}, 'title': {'title': 'Title', 'type': 'string'}, 'genre': {'title': 'Genre', 'type': 'string'}, 'director': {'title': 'Director', 'type': 'string'}, 'cast': {'title': 'Cast', 'type': 'array', 'items': {'type': 'string'}}}, 'required': ['movieId', 'title', 'genre', 'director', 'cast']}\n</schema>\n"
    },
    {
      "from": "human",
      "value": "I'm organizing a movie database and need to create a structured JSON object for each film entry. The next movie I want to add is 'Interstellar', which has a unique movie ID 'INTSTL_2014'. The genre is 'Science Fiction', directed by Christopher Nolan. The main cast includes Matthew McConaughey as 'Cooper', Anne Hathaway as 'Brand', Jessica Chastain as 'Murph', and Michael Caine as 'Professor Brand'."
    },
    {
      "from": "gpt",
      "value": "{\"movieId\": \"INTSTL_2014\", \"title\": \"Interstellar\", \"genre\": \"Science Fiction\", \"director\": \"Christopher Nolan\", \"cast\": [\"Matthew McConaughey as Cooper\", \"Anne Hathaway as Brand\", \"Jessica Chastain as Murph\", \"Michael Caine as Professor Brand\"]}"
    }
  ],
  "category": "Media & Entertainment",
  "subcategory": "Media",
  "schema": "{\"title\": \"MovieDatabaseEntry\", \"type\": \"object\", \"properties\": {\"movieId\": {\"title\": \"Movie ID\", \"type\": \"string\"}, \"title\": {\"title\": \"Title\", \"type\": \"string\"}, \"genre\": {\"title\": \"Genre\", \"type\": \"string\"}, \"director\": {\"title\": \"Director\", \"type\": \"string\"}, \"cast\": {\"title\": \"Cast\", \"type\": \"array\", \"items\": {\"type\": \"string\"}}}, \"required\": [\"movieId\", \"title\", \"genre\", \"director\", \"cast\"]}",
  "__index_level_0__": 671
}
```

### JSON-mode with Agentic Schemas:
```json
{
  "id": "c0618e9a-d832-4e2f-b9fe-28c8d8ca8007",
  "conversations": [
    {
      "from": "system",
      "value": "You are a helpful assistant that answers in JSON. Here's the json schema you must adhere to:\n<schema>\n{'type': 'object', 'properties': {'agent_execution': {'type': 'object', 'properties': {'task_decomposition': {'type': 'string'}, 'action_retrieval': {'type': 'string'}, 'code_execution': {'type': 'string'}, 'error_analysis': {'type': 'string'}, 'code_amendment': {'type': 'string'}, 'execution_critique': {'type': 'string'}, 'task_replanning': {'type': 'string'}}, 'required': ['task_decomposition', 'action_retrieval', 'code_execution', 'error_analysis', 'code_amendment', 'execution_critique', 'task_replanning']}}}\n</schema>\n"
    },
    {
      "from": "human",
      "value": "As a software engineer, I'm currently working on integrating an agent execution framework into our system to automate complex tasks. I need to generate a JSON object that represents the process of executing a task where the agent decomposes the task into subtasks, retrieves the necessary actions from an action library, and executes code to fulfill the task requirements. The task at hand is to automate the process of data migration from one database to another, ensuring data integrity and handling any errors that may arise. The agent should also provide a critique of the task execution and replan the task if necessary. Specifically, the agent decomposes the data migration task into subtasks such as data extraction, data transformation, and data loading. It then retrieves actions like 'extract_data', 'transform_data', and 'load_data' from the action library. Following this, the agent executes the retrieved code snippets for each subtask, ensuring data integrity throughout the migration process. During this process, the agent analyzes any errors encountered during execution, identifying issues such as data format mismatches or connectivity problems. Based on the error analysis, the agent amends the code to handle exceptions and retry the subtask. After the execution, the agent provides a critique of the execution, highlighting successful completions and areas that required amendments. If a subtask cannot be completed successfully after amendments, the agent replans the task by decomposing it into alternative subtasks, thus ensuring a robust and adaptive approach to task automation."
    },
    {
      "from": "gpt",
      "value": "{\"agent_execution\": {\"task_decomposition\": \"The agent decomposes the data migration task into subtasks such as data extraction, data transformation, and data loading.\", \"action_retrieval\": \"The agent retrieves actions like 'extract_data', 'transform_data', and 'load_data' from the action library.\", \"code_execution\": \"The agent executes the retrieved code snippets for each subtask, ensuring data integrity throughout the migration process.\", \"error_analysis\": \"The agent analyzes any errors encountered during execution, identifying issues such as data format mismatches or connectivity problems.\", \"code_amendment\": \"The agent amends the code based on the error analysis to handle exceptions and retry the subtask.\", \"execution_critique\": \"The agent provides a critique of the execution, highlighting successful completions and areas that required amendments.\", \"task_replanning\": \"If a subtask cannot be completed successfully after amendments, the agent replans the task by decomposing it into alternative subtasks.\"}}"
    }
  ],
  "category": "Copilot Frameworks",
  "subcategory": "Agent Execution",
  "schema": "{\"type\": \"object\", \"properties\": {\"agent_execution\": {\"type\": \"object\", \"properties\": {\"task_decomposition\": {\"type\": \"string\"}, \"action_retrieval\": {\"type\": \"string\"}, \"code_execution\": {\"type\": \"string\"}, \"error_analysis\": {\"type\": \"string\"}, \"code_amendment\": {\"type\": \"string\"}, \"execution_critique\": {\"type\": \"string\"}, \"task_replanning\": {\"type\": \"string\"}}, \"required\": [\"task_decomposition\", \"action_retrieval\", \"code_execution\", \"error_analysis\", \"code_amendment\", \"execution_critique\", \"task_replanning\"]}}}"
}
```
# How to cite:

```bibtext
@misc{Hermes-Function-Calling-Dataset-V1, 
      url={https://huggingface.co/NousResearch/hermes-function-calling-v1}, c
      title={Hermes-Function-Calling-Dataset-V1}, 
      author={"interstellarninja", "Teknium"}
}
```