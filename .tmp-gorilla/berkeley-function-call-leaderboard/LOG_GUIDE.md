# Guide to Inference Logs

> An inference log is included along with the llm response in the results file to help you analyze and debug the model's performance, and to better understand the model behavior. To enable a more detailed log, use the `--include-input-log` flag in the generation command.

## Log Structure

The log is structured as a list, representing a conversational interaction between the model, system, and user. There are five types of roles in the log:

1. **`user`**: Represents the user's input or query.
2. **`assistant`**: Represents the model's raw response.
3. **`tool`**: Represents the output of a function execution, if the model makes a valid function call. Each function call results in a separate `tool` entry.
4. **`state_info`**: Represents the state of the backend API system at the end of each turn. The initial state is also included at the beginning of the log. You can exclude this entry by using the `--exclude-state-log` flag in the generation command.
5. **`inference_input`**: Snapshot of the fully-transformed input just before it's sent to the model API endpoint. Useful for debugging input integrity and format.

   - Available only if the `--include-input-log` flag is set  in the generation command.
   - This section can be verbose and may affect log  readability; it is generally not necessary for most  analyses.

6. **`handler_log`**: Represents internal logs from the inference pipeline. These entries indicate various stages and events within the pipeline, including:
   - **decode_success**: Indicates the successful decoding of the model's raw response, with the decoded response included in the `model_response_decoded` field. Following this, any function calls are executed, and the current turn continues.
   - **empty_response**: Indicates that the model handler returned an empty response (e.g., no function call) based on the decoding strategy. When this occurs, the pipeline proceeds to the next turn.
   - **decode_failure**: Indicates a failure in decoding the raw model response, with the raw response included in the `model_response_decoded` field. The pipeline then proceeds to the next turn.
   - **force_quit**: Indicates that the model handler has forcefully ended the conversation after the model made 20 unsuccessful attempts (eg, steps) within one turn or task; the count reset at the beginning of each turn. No further turns are processed for this entry.

## Single Turn Categories

For single-turn categories, the only log entry available is the inference input (under `handler_log` role), because there is no interaction with the model or system.

## Ground Truth

For multi-turn categories, we understand the provided ground truth may seem nonsensical without context. We have provided a utility script to simulate a conversation between the ground truth and the system:

```bash
cd berkeley-function-call-leaderboard/bfcl_eval/scripts
python visualize_multi_turn_ground_truth_conversation.py
```

The generated conversation logs will be saved in `berkeley-function-call-leaderboard/bfcl_eval/scripts/ground_truth_conversation`.
