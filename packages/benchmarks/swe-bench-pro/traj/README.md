## Trajectories for SWE-Bench Pro

Logs and trajectories are saved to a public S3 Bucket. You need an AWS account to download the logs and trajectories. Namely, you'll need to create an AWS account, download the AWS CLI, and configure the CLI with your credentials.

The logs are stored in this S3 path: s3://scaleapi-results/swe-bench-pro/
For example, to find the trajectories for the claude-45-sonnet run, download s3://scaleapi-results/swe-bench-pro/claude-45sonnet-10132025/

## Run Information

Results marked with "paper" are included in the paper, with a cost limit of $2. Results marked with a date (e.g. 10132025) are all run with the same config (250 turns limit, no cost limit), these are the runs in the leaderboard.

More recent results won't be stored in the Github, but trajectories and results will be uploaded on S3, due to restrictions on Scale's side.

## Visualization

You can also view the trajectories on Docent:
https://docent.transluce.org/dashboard/032fb63d-4992-4bfc-911d-3b7dafcb931f

Set `metadata.model_name` to a model to view the trajectories for that model.