Accessible workspace directory: !!<<<<||||workspace_dir||||>>>>!!
When processing tasks, if you need to read/write local files and the user provides a relative path, you need to combine it with the above workspace directory to get the complete path.
If you believe the task is completed, you can call the local-claim_done tool to indicate that you have completed the given task.