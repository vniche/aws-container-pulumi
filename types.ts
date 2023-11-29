import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Subnet } from "@vniche/aws-vpc-pulumi";

export type Tags = pulumi.Input<{
  [key: string]: pulumi.Input<string>;
}> | undefined;

export type ServiceConfig = {
  name: string;
  image: string;
  port: number;
  cpu?: string;
  memory?: string;
  autoscaling?: AutoscalingConfig;
  hostedZone?: string;
};

export type CreateServiceArgs = ServiceConfig & {
  vpcId: pulumi.Output<string>;
  region: aws.Region;
  subnets: Subnet[];
  tags?: Tags;
};

export type CreateSecurityGroupArgs = {
  serviceName: string;
  port: number;
  vpcId: pulumi.Output<string>;
  lbSecurityGroupId: pulumi.Output<string>;
  tags?: Tags;
};

export type AutoscalingConfig = {
  min: number;
  max: number;
  cpuAvgThreshold?: number;
};

export type CreateLoadBalancerArgs = {
  serviceName: string;
  vpcId: pulumi.Output<string>;
  subnets: Subnet[];
  hostedZone?: string;
  tags?: Tags;
}

export type LoadBalancer = {
  securityGroupId: pulumi.Output<string>;
  targetGroupArn: pulumi.Output<string>;
  dnsName?: pulumi.Output<string>;
}