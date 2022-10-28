import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as aws_route53 from 'aws-cdk-lib/aws-route53';

import { Stack, StackProps, Aspects, aws_route53_targets } from 'aws-cdk-lib';
import { Duration, SecretValue, RemovalPolicy, Tag } from 'aws-cdk-lib';

// Function to tag resources
const tagResources = (resources: any[], tagName: string, tagValue: string) => {
  for (const resource of resources) {
    Aspects.of(resource).add(new Tag(tagName, tagValue));
  }
};

export class WordpressAppStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // VPC, Subnets, NAT, IGW
    const vpc = new ec2.Vpc(this, 'vpc', {
      vpcName: 'wordpress-vpc',
      cidr: process.env.VPC_CIDR,
      maxAzs: parseInt(process.env.MAX_AZ || '2'),
      natGateways: parseInt(process.env.NAT_GW || '1'),
      natGatewaySubnets: {
        subnetGroupName: 'ingress'
      },
      subnetConfiguration: [
        {
          cidrMask: parseInt(process.env.PUB_SUB_MASK || '24'),
          name: 'ingress',
          mapPublicIpOnLaunch: true,
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: parseInt(process.env.PRIV_SUB_MASK || '24'),
          name: 'application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: parseInt(process.env.ISO_SUB_MASK || '28'),
          name: 'database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true
    });

    // ECS Application SG
    const appSG = new ec2.SecurityGroup(this, 'appSG', {
      securityGroupName: 'wordpress-app',
      vpc: vpc,
      allowAllOutbound: true,
      description: 'Security Group for wordpress application'
    });

    // Database Security Group
    const dbSG = new ec2.SecurityGroup(this, 'dbSG', {
      securityGroupName: 'wordpress-db',
      vpc: vpc,
      allowAllOutbound: false,
      description: 'Security Group for wordpress database'
    });

    // Ingress Rule
    dbSG.addIngressRule(
      ec2.Peer.securityGroupId(appSG.securityGroupId.toString()),
      ec2.Port.tcp(3306),
      'Allow access from wordpress application'
    );

    // Egress Rule
    dbSG.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock.toString()),
      ec2.Port.allTraffic(),
      'Allow outbound to VPC'
    );

    // Database Subnet Group
    const dbSubnetGroup = new rds.SubnetGroup(this, 'DBSubnetGroup', {
      description: 'Wordpress DB subnet group',
      vpc: vpc,
      subnetGroupName: 'wordpress-db',
      vpcSubnets: {
        availabilityZones: vpc.availabilityZones,
        onePerAz: false,
        subnetGroupName: 'database'
      },
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Database Instance
    const db = new rds.DatabaseInstance(this, 'rds', {
      instanceIdentifier: 'wordpress-db',
      databaseName: process.env.DB_NAME || 'wordpress',
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorage: parseInt(process.env.STORAGE || '10'),
      multiAz: true,
      port: 3306,
      subnetGroup: dbSubnetGroup,
      publiclyAccessible: false,
      vpcSubnets: {
        subnetGroupName: 'database'
      },
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_30
      }),
      credentials: {
        username: process.env.DB_USER || 'wordpress',
        password: SecretValue.unsafePlainText(process.env.DB_PASSWORD || 'wordpress')
      },
      securityGroups: [dbSG],
      removalPolicy: RemovalPolicy.DESTROY,
      vpc: vpc
    });

    // Auto Scaling Group
    const asg = new autoscaling.AutoScalingGroup(this, 'asg', {
      vpc: vpc,
      autoScalingGroupName: 'Wordpress App ASG',
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      desiredCapacity: parseInt(process.env.MIN_CAP || '1'),
      maxCapacity: parseInt(process.env.MAX_CAP || '2'),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
      vpcSubnets: {
        subnets: vpc.privateSubnets
      },
      securityGroup: appSG
    });

    // Dynamic Scaling based on cpu utilization
    asg.scaleOnCpuUtilization('asg-cpu-scaling', {
      targetUtilizationPercent: 50
    });

    // Capacity Provider
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup: asg
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'wordpress-cluster', {
      clusterName: 'Wordpress-Cluster',
      vpc: vpc
    });
    cluster.addAsgCapacityProvider(capacityProvider);
    cluster.connections.addSecurityGroup(appSG);

    // ECS Service
    const wordpressService = new ecs_patterns.ApplicationLoadBalancedEc2Service(this, "wordpress-service", {
      cluster: cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      listenerPort: 80,
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('wordpress'),
        environment: {
          WORDPRESS_DB_HOST: db.instanceEndpoint.hostname,
          WORDPRESS_DB_USER: process.env.DB_USER || 'wordpress',
          WORDPRESS_DB_PASSWORD: process.env.DB_PASSWORD || 'wordpress',
          WORDPRESS_DB_NAME: process.env.DB_NAME || 'wordpress',
        },
        containerPort: 80
      },
      desiredCount: parseInt(process.env.MIN_CAP || '1'),
      serviceName: 'wordpress-app'
    });

    // Health check for targets
    wordpressService.targetGroup.configureHealthCheck({
      path: '/',
      healthyHttpCodes: "200-399"
    });

    // Scalable Target
    const scalableTarget = wordpressService.service.autoScaleTaskCount({
      minCapacity: parseInt(process.env.MIN_CAP || '1'),
      maxCapacity: parseInt(process.env.MAX_CAP || '2'),
    });

    // Task scaling based on cpu 
    scalableTarget.scaleOnCpuUtilization('task-cpu-scaling', {
      targetUtilizationPercent: parseInt(process.env.CPU_CONS || '50')
    });

    // Task scaling based on memory
    scalableTarget.scaleOnMemoryUtilization('task-memory-scaling', {
      targetUtilizationPercent: parseInt(process.env.MEM_CONS || '50')
    });

    // Hosted Zone
    const hostedZone = new aws_route53.HostedZone(this, 'wordpress-hz', {
      zoneName: process.env.ZONE_NAME || 'wordpress101.com'
    })

    // Route traffic `app.wordpress101.com` to the Load Balancer
    new aws_route53.ARecord(this, 'wordpress-dns-record', {
      recordName: 'app',
      zone: hostedZone,
      target: aws_route53.RecordTarget.fromAlias(new aws_route53_targets.LoadBalancerTarget(wordpressService.loadBalancer)),
      ttl: Duration.minutes(parseInt(process.env.TTL || '30'))
    });

    // Tag Resources
    tagResources(vpc.publicSubnets, 'Name', 'Wordpress Ingress');
    tagResources(vpc.privateSubnets, 'Name', 'Wordpress Application');
    tagResources(vpc.isolatedSubnets, 'Name', 'Wordpress Database');

    tagResources([wordpressService.loadBalancer], 'Name', 'Wordpress LB Ingress');
    tagResources([appSG], 'Name', 'Wordpress Application');
    tagResources([dbSG], 'Name', 'Wordpress Database');
  }
}
