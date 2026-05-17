# 火山引擎ECS提供商配置指南

本指南介绍如何为OSWorld桌面环境配置和使用火山引擎ECS。

## 配置流程

1. **火山引擎账户**：您需要一个有效的火山引擎账户，本脚本默认ECS通过按量付费方式拉起，需保证账户余额在100以上。
2. **访问密钥**：在火山引擎IAM控制台中创建AccessKey ID和SecretAccessKey，并授权ECS控制权限
3. **VPC设置**：在目标地域创建VPC、子网和安全组
4. **自定义镜像**：创建OSWorld自定义镜像
5. 建议手动完成一次ECS创建流程后，记录所有需要的环境变量信息。

## 环境变量

在您的`.env`文件中设置以下环境变量：

```bash
# 火山引擎访问凭证
VOLCENGINE_ACCESS_KEY_ID=your_access_key_id
VOLCENGINE_SECRET_ACCESS_KEY=your_secret_access_key

# ECS配置信息
VOLCENGINE_REGION=ap-southeast-1
VOLCENGINE_IMAGE_ID=image-xxxxxxxxx
VOLCENGINE_INSTANCE_TYPE=ecs.e-c1m2.large
VOLCENGINE_SUBNET_ID=subnet-xxxxxxxxx
VOLCENGINE_SECURITY_GROUP_ID=sg-xxxxxxxxx
VOLCENGINE_ZONE_ID=zone-xxxxxxxxx
VOLCENGINE_DEFAULT_PASSWORD=your_default_password
```

## 所需火山引擎资源

### 1. VPC和子网
- 在目标地域创建VPC
- 在VPC内创建子网
- 确保子网具有互联网访问能力以支持VNC连接

### 2. 安全组
**⚠️ 重要提示**：请严格按照以下端口设置，以防止OSWorld任务因连接问题而失败：

#### 入方向规则（需要8条规则）

| 类型 | 协议 | 端口范围 | 源地址 | 描述 |
|------|------|----------|--------|------|
| SSH | TCP | 22 | 0.0.0.0/0 | SSH访问 |
| HTTP | TCP | 80 | 172.31.0.0/16 | HTTP流量 |
| 自定义TCP | TCP | 5000 | 172.31.0.0/16 | OSWorld后端服务 |
| 自定义TCP | TCP | 5910 | 0.0.0.0/0 | NoVNC可视化端口 |
| 自定义TCP | TCP | 8006 | 172.31.0.0/16 | VNC服务端口 |
| 自定义TCP | TCP | 8080 | 172.31.0.0/16 | VLC服务端口 |
| 自定义TCP | TCP | 8081 | 172.31.0.0/16 | 附加服务端口 |
| 自定义TCP | TCP | 9222 | 172.31.0.0/16 | Chrome控制端口 |

#### 出方向规则（需要1条规则）

| 类型 | 协议 | 端口范围 | 目标地址 | 描述 |
|------|------|----------|----------|------|
| 全部流量 | 全部 | 全部 | 0.0.0.0/0 | 允许所有出站流量 |

### 3. 自定义镜像
您需要为火山引擎ECS创建自定义OSWorld镜像。请按照"为OSWorld创建自定义ECS镜像"部分的说明进行操作。

## 为OSWorld创建自定义ECS镜像

本部分提供如何创建OSWorld桌面环境所需的自定义ECS镜像的指导。该过程包括设置带有桌面环境和VNC服务器的基础实例，然后从中创建自定义镜像。

### 镜像创建过程
- 从`desktop_env/providers/docker/manager.py`中的链接下载提供的qcow2镜像：https://huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/Ubuntu.qcow2.zip
- 解压下载的文件并上传到火山引擎对象存储服务（TOS）。确保TOS与您要启动ECS实例的目标地域在同一地域。
- 在您的ECS控制台中，转到"镜像"页面，您将看到"导入镜像"按钮。点击它并按照说明从TOS导入qcow2镜像。
- 导入完成后，您将在"镜像"列表中看到导入的镜像。
