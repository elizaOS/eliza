# ☁ Configuration of AWS

---

Welcome to the AWS VM Management documentation. Before you proceed with using the code to manage AWS services, please ensure the following variables are set correctly according to your AWS environment.

## Overview
The AWS cloud service architecture consists of a host machine that controls multiple virtual machines (each virtual machine serves as an OSWorld environment, for which we provide AMI images) for testing and potential training purposes. To prevent security breaches, we need to properly configure security groups for both the host machine and virtual machines, as well as configure appropriate subnets.

## Security Group Configuration

### Security Group for OSWorld Virtual Machines
OSWorld requires certain ports to be open, such as port 5000 for backend connections to OSWorld services, port 5910 for VNC visualization, port 9222 for Chrome control, etc. The `AWS_SECURITY_GROUP_ID` variable represents the security group configuration for virtual machines serving as OSWorld environments. Please complete the configuration and set this environment variable to the ID of the configured security group.

**⚠️ Important**: Please strictly follow the port settings below to prevent OSWorld tasks from failing due to connection issues:

#### Inbound Rules (8 rules required)

| Type | Protocol | Port Range | Source | Description |
|------|----------|------------|--------|-------------|
| SSH | TCP | 22 | 0.0.0.0/0 | SSH access |
| HTTP | TCP | 80 | 172.31.0.0/16 | HTTP traffic |
| Custom TCP | TCP | 5000 | 172.31.0.0/16 | OSWorld backend service |
| Custom TCP | TCP | 5910 | 0.0.0.0/0 | NoVNC visualization port |
| Custom TCP | TCP | 8006 | 172.31.0.0/16 | VNC service port |
| Custom TCP | TCP | 8080 | 172.31.0.0/16 | VLC service port |
| Custom TCP | TCP | 8081 | 172.31.0.0/16 | Additional service port |
| Custom TCP | TCP | 9222 | 172.31.0.0/16 | Chrome control port |

#### Outbound Rules (1 rule required)

| Type | Protocol | Port Range | Destination | Description |
|------|----------|------------|-------------|-------------|
| All traffic | All | All | 0.0.0.0/0 | Allow all outbound traffic |

### Host Machine Security Group Configuration
Configure according to your specific requirements. This project provides a monitor service that runs on port 8080 by default. You need to open this port to use this functionality.


## VPC Configuration  
To isolate the entire evaluation stack, we run both the host machine and all client virtual machines inside a dedicated VPC. The setup is straightforward:

1. Launch the host instance via the AWS console and note the **VPC ID** and **Subnet ID** shown in its network settings.  
2. Export the same **Subnet ID** as the environment variable `AWS_SUBNET_ID` before starting the client code.  
   ```bash
   export AWS_SUBNET_ID=subnet-xxxxxxxxxxxxxxxxx
   ```
   (Both the client and host must reside in this subnet for the evaluation to work.)


## Configuration Variables
That’s essentially all the setup you need to perform. From here on, you only have to supply a few extra details and environment variables—just make sure they’re all present in your environment.

You need to assign values to several variables crucial for the operation of these scripts on AWS:

- **`DEFAULT_REGION`**: Default AWS region where your instances will be launched.
  - Example: `"us-east-1"`
- **`IMAGE_ID_MAP`**: Dictionary mapping regions to specific AMI IDs that should be used for instance creation. Here we already set the AMI id to the official OSWorld image of Ubuntu supported by us.
  - Formatted as follows:
    ```python
    IMAGE_ID_MAP = {
        "us-east-1": "ami-0d23263edb96951d8"
        # Add other regions and corresponding AMIs
    }
    ```
- **`INSTANCE_TYPE`**: Specifies the type of EC2 instance to be launched.
  - Example: `"t3.medium"`
- **`KEY_NAME`**: Specifies the name of the key pair to be used for the instances.
  - Example: `"osworld_key"`
- **`NETWORK_INTERFACES`**: Configuration settings for network interfaces, which include subnet IDs, security group IDs, and public IP addressing.
  - Example:
    ```bash
    <!-- in .env file -->
    AWS_REGION=us-east-1
    AWS_SUBNET_ID=subnet-xxxx
    AWS_SECURITY_GROUP_ID=sg-xxxx
    ```

### AWS CLI Configuration
Before using these scripts, you must configure your AWS CLI with your credentials. This can be done via the following commands:

```bash
aws configure
```
This command will prompt you for:
- AWS Access Key ID
- AWS Secret Access Key
- Default region name (Optional, you can press enter)

Enter your credentials as required. This setup will allow you to interact with AWS services using the credentials provided.

### Disclaimer
Use the provided scripts and configurations at your own risk. Ensure that you understand the AWS pricing model and potential costs associated with deploying instances, as using these scripts might result in charges on your AWS account.

> **Note:**  Ensure all AMI images used in `IMAGE_ID_MAP` are accessible and permissioned correctly for your AWS account, and that they are available in the specified region.
