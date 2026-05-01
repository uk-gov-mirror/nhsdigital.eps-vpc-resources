import {
  App,
  CfnOutput,
  CfnResource,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps
} from "aws-cdk-lib"
import {
  CfnSubnet,
  FlowLogDestination,
  FlowLogMaxAggregationInterval,
  FlowLogOptions,
  FlowLogTrafficType,
  GatewayVpcEndpoint,
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  IpAddresses,
  IVpcEndpoint,
  Peer,
  Vpc
} from "aws-cdk-lib/aws-ec2"
import {Role, ServicePrincipal} from "aws-cdk-lib/aws-iam"
import {Bucket} from "aws-cdk-lib/aws-s3"
import {Key} from "aws-cdk-lib/aws-kms"
import {LogGroup} from "aws-cdk-lib/aws-logs"
import {AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId} from "aws-cdk-lib/custom-resources"

import {nagSuppressions} from "../nagSuppressions"

export interface VpcResourcesStackProps extends StackProps{
  readonly version: string
  readonly availabilityZones: Array<string>
  readonly logRetentionInDays: number
  readonly forwardCsocLogs: boolean
}

/**
 * EPS VPC Resources

 */

export class VpcResourcesStack extends Stack {
  readonly vpc : Vpc
  public constructor(scope: App, id: string, props: VpcResourcesStackProps){
    super(scope, id, props)

    // Imports
    const cloudwatchKmsKey = Key.fromKeyArn(
      this, "cloudwatchKmsKey", Fn.importValue("account-resources-cdk-uk:KMS:CloudwatchLogsKmsKey:Arn"))

    // Resources
    const flowLogsRole = new Role(this, "VpcFlowLogsRole", {
      assumedBy: new ServicePrincipal("vpc-flow-logs.amazonaws.com")
    }).withoutPolicyUpdates()

    const flowLogsLogGroup = new LogGroup(this, "VpcFlowLogsLogGroup", {
      logGroupName: `/aws/vpc/${props.stackName}-vpc-flow-logs`,
      retention: props.logRetentionInDays,
      encryptionKey: cloudwatchKmsKey,
      removalPolicy: RemovalPolicy.DESTROY
    })

    // Build flow logs configuration
    const flowLogsConfig: Record<string, FlowLogOptions> = {
      "FlowLogCloudwatch": {
        destination: FlowLogDestination.toCloudWatchLogs(flowLogsLogGroup, flowLogsRole)
      }
    }

    // Conditionally add S3 flow logs if forwardCsocLogs is true
    if (props.forwardCsocLogs) {
      const vpcFlowLogsBucket = Bucket.fromBucketArn(
        this,
        "VpcFlowLogsBucket",
        "arn:aws:s3:::nhsd-audit-vpcflowlogs"
      )

      flowLogsConfig["FlowLogS3"] = {
        destination: FlowLogDestination.toS3(vpcFlowLogsBucket),
        trafficType: FlowLogTrafficType.ALL,
        maxAggregationInterval: FlowLogMaxAggregationInterval.TEN_MINUTES
      }
    }

    const vpc = new Vpc(this, "vpc", {
      ipAddresses: IpAddresses.cidr("10.190.0.0/16"),
      enableDnsSupport: true,
      enableDnsHostnames: true,
      availabilityZones: props.availabilityZones,
      flowLogs: flowLogsConfig
    })

    // Add cfn-guard suppressions
    for (const subnet of vpc.publicSubnets) {
      const cfnSubnet = subnet.node.defaultChild as CfnSubnet
      cfnSubnet.cfnOptions.metadata = {
        guard:
        {
          SuppressedRules:[
            "SUBNET_AUTO_ASSIGN_PUBLIC_IP_DISABLED"
          ]
        }
      }

      const cfnSubnetAsChild = vpc.node.tryFindChild(subnet.node.id) as CfnResource
      const cfnDefaultRoute = cfnSubnetAsChild.node.tryFindChild("DefaultRoute") as CfnResource
      cfnDefaultRoute.cfnOptions.metadata = {
        guard:
        {
          SuppressedRules:[
            "NO_UNRESTRICTED_ROUTE_TO_IGW"
          ]
        }
      }
    }

    this.vpc = vpc

    // add vpc private endpoints - needed to run ECS in private subnet
    // copied from https://stackoverflow.com/a/69578964/9294145
    this.addInterfaceEndpoint("ECRDockerEndpoint", InterfaceVpcEndpointAwsService.ECR_DOCKER)
    this.addInterfaceEndpoint("ECREndpoint", InterfaceVpcEndpointAwsService.ECR)
    this.addInterfaceEndpoint("SecretManagerEndpoint", InterfaceVpcEndpointAwsService.SECRETS_MANAGER)
    this.addInterfaceEndpoint("CloudWatchEndpoint", InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING)
    this.addInterfaceEndpoint("CloudWatchLogsEndpoint", InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS)
    this.addInterfaceEndpoint("CloudWatchEventsEndpoint", InterfaceVpcEndpointAwsService.EVENTBRIDGE)
    this.addInterfaceEndpoint("SSMEndpoint", InterfaceVpcEndpointAwsService.SSM)
    this.addInterfaceEndpoint("LambdaEndpoint", InterfaceVpcEndpointAwsService.LAMBDA)
    this.addGatewayEndpoint("S3Endpoint", InterfaceVpcEndpointAwsService.S3)

    //Outputs

    //Exports
    new CfnOutput(this, "VpcID", {
      value: vpc.vpcId,
      exportName: `${props.stackName}:VpcId`
    })

    let publicSubnetIds = []
    for (const [i, subnet] of vpc.publicSubnets.entries()){
      const subnetIdentifier = String.fromCharCode("A".charCodeAt(0) + i)
      new CfnOutput(this, `PublicSubnet${subnetIdentifier}`, {
        value: subnet.subnetId,
        exportName: `${props.stackName}:PublicSubnet${subnetIdentifier}`
      })
      publicSubnetIds.push(subnet.subnetId)
    }

    let privateSubnetIds = []
    for (const [i, subnet] of vpc.privateSubnets.entries()){
      const subnetIdentifier = String.fromCharCode("A".charCodeAt(0) + i)
      new CfnOutput(this, `PrivateSubnet${subnetIdentifier}`, {
        value: subnet.subnetId,
        exportName: `${props.stackName}:PrivateSubnet${subnetIdentifier}`
      })
      privateSubnetIds.push(subnet.subnetId)
    }

    new CfnOutput(this, "PublicSubnets", {
      value: publicSubnetIds.join(","),
      exportName: `${props.stackName}:PublicSubnets`
    })

    new CfnOutput(this, "PrivateSubnets", {
      value: privateSubnetIds.join(","),
      exportName: `${props.stackName}:PrivateSubnets`
    })

    nagSuppressions(this)

  }

  private addInterfaceEndpoint(name: string, awsService: InterfaceVpcEndpointAwsService): void {
    const endpoint: InterfaceVpcEndpoint = this.vpc.addInterfaceEndpoint(name, {
      service: awsService
    })
    this.addEndpointTag(name, endpoint)

    endpoint.connections.allowFrom(Peer.ipv4(this.vpc.vpcCidrBlock), endpoint.connections.defaultPort!)
  }

  private addGatewayEndpoint(name: string, awsService: InterfaceVpcEndpointAwsService): void {
    const endpoint: GatewayVpcEndpoint = this.vpc.addGatewayEndpoint(name, {
      service: awsService
    })
    this.addEndpointTag(name, endpoint)
  }

  private addEndpointTag(name: string, endpoint: IVpcEndpoint) {
    // vpc endpoints do not support tagging from cdk/cloudformation
    // so use a custom resource to add them in
    new AwsCustomResource(this, `${name}-tags`, {
      installLatestAwsSdk: false,
      onUpdate: {
        action: "createTags",
        parameters: {
          Resources: [
            endpoint.vpcEndpointId
          ],
          Tags: [
            {
              Key: "Name",
              Value: `${this.stackName}-${name}`
            }
          ]
        },
        physicalResourceId: PhysicalResourceId.of(Date.now().toString()),
        service: "EC2"
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE
      })
    })
  }
}
