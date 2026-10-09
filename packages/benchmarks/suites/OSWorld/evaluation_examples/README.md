# Evaluation examples

Here we put the data examples to benchmark the ability of agents when interacting with GUI.
The examples are stored in `./examples` where each data item formatted as:

```
{
    "id": "uid", # unique id
    "snapshot": "snapshot_id", # the snapshot id of the environment, with some data already there and apps already opened, or just desktop
    "instruction": "natural_language_instruction", # the natural language instruction of the task, what we want the agent to do
    "source": "website_url", # where we know this example, some forum, or some website, or some paper
    "config": {xxx}, # the scripts to setup the donwload and open files actions, as the initial state of a task
    # (coming in next project) "trajectory": "trajectory_directory", # the trajectory directory, which contains the action sequence file, the screenshots and the recording video
    "related_apps": ["app1", "app2", ...], # the related apps, which are opened during the task
    "evaluator": "evaluation_dir", # the directory of the evaluator, which contains the evaluation script for this example
…
}
```

The `./trajectories` file contains the annotated trajectories for each data item in `./examples` for finishing the task.

For now, it is under construction, and only tested on Windows 10. Please:
- Modify the path accordingly to run the evaluation;
- Remind us if some parts are overfit to our environment.
