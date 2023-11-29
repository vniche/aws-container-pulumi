import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { CreateServiceArgs, CreateSecurityGroupArgs, CreateLoadBalancerArgs, LoadBalancer } from "./types";

const stack = pulumi.getStack();
const stackName = (name: string) => `${name}-${stack}`;

const identity = aws.getCallerIdentityOutput();

export class Service extends pulumi.ComponentResource {
  /**
   *  The name given to the Service resource.
   */
  private name: string;

  /**
   *  The resulting URL of the provisioned service.
   */
  readonly url: pulumi.Output<string> | string;

  /**
   * Validates a service creation arguments.
   * 
   * @param args The arguments to use to populate resource's properties.
   */
  private validateServiceArgs(args: CreateServiceArgs) {
    // TODO: validate args
  }

  /**
   * Create a Security Group resource with the given arguments, and options.
   * 
   * @param args The arguments to use to populate this resource's properties.
   * @param opts A bag of options that control this resource's behavior.
   * @returns the created Security Group Pulumi resource
   */
  private createSecurityGroup(args: CreateSecurityGroupArgs, opts?: pulumi.CustomResourceOptions): aws.ec2.SecurityGroup {
    const { vpcId, serviceName, port, lbSecurityGroupId, tags } = args;

    return new aws.ec2.SecurityGroup(`${this.name}-security-group`, {
      name: `ecs-${stackName(serviceName)}`,
      vpcId,
      ingress: [
        {
          protocol: "tcp",
          fromPort: port,
          toPort: port,
          securityGroups: [lbSecurityGroupId]
        }
      ],
      egress: [
        {
          protocol: "all",
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ["0.0.0.0/0"]
        }
      ],
      tags
    }, opts);
  }

  /**
   * Create a Load Balancer resource with the given arguments, and options.
   * 
   * @param args The arguments to use to populate this resource's properties.
   * @param opts A bag of options that control this resource's behavior.
   * @returns the created Load Balancer Pulumi resource
   */
  private createLoadBalancer(args: CreateLoadBalancerArgs, opts?: pulumi.CustomResourceOptions): LoadBalancer {
    const { serviceName, vpcId, subnets, hostedZone, tags } = args;
    const exposedPort = hostedZone ? 443 : 80;

    const albSecurityGroup = new aws.ec2.SecurityGroup(`${this.name}-alb-security-group`, {
      name: `alb-${stackName(serviceName)}`,
      vpcId,
      ingress: [
        {
          protocol: "tcp",
          fromPort: exposedPort,
          toPort: exposedPort,
          cidrBlocks: ["0.0.0.0/0"]
        }
      ],
      tags
    }, opts);

    const alb = new aws.lb.LoadBalancer(`${this.name}-app-lb`, {
      internal: false,
      securityGroups: [albSecurityGroup.id],
      subnets: subnets.map(({ resource }) => resource.id),
      tags
    }, opts);

    const albTargetGroup = new aws.lb.TargetGroup(`${this.name}-lb-target-group`, {
      port: 80,
      protocol: "HTTP",
      targetType: "ip",
      vpcId,
      tags
    }, opts);

    const albListenerConfig: aws.lb.ListenerArgs = {
      loadBalancerArn: alb.arn,
      port: exposedPort,
      protocol: hostedZone ? "HTTPS" : "HTTP",
      defaultActions: [{
        type: "forward",
        targetGroupArn: albTargetGroup.arn
      }],
      tags
    };

    const albListenerDependencies: pulumi.Input<pulumi.Input<pulumi.Resource>[]> = [albTargetGroup];

    if (hostedZone) {
      const serviceDomain = `${stackName(serviceName)}.${hostedZone}`;

      const zone = aws.route53.getZone({ name: hostedZone });

      new aws.route53.Record(`${this.name}-dns-record`, {
        name: serviceDomain,
        type: "A",
        zoneId: zone.then(zone => zone.zoneId),
        aliases: [
          {
            name: alb.dnsName,
            zoneId: alb.zoneId,
            evaluateTargetHealth: true,
          },
        ],
      }, opts);

      const cert = new aws.acm.Certificate(`${this.name}-certificate`, {
        domainName: serviceDomain,
        validationMethod: "DNS",
        tags
      }, opts);

      const validationDNS = new aws.route53.Record(`${this.name}-certificate-dns-validation`, {
        name: cert.domainValidationOptions[0].resourceRecordName,
        type: "CNAME",
        zoneId: zone.then(zone => zone.zoneId),
        records: [cert.domainValidationOptions[0].resourceRecordValue],
        ttl: 300
      }, opts);

      const certificateValidation = new aws.acm.CertificateValidation(`${this.name}-certificate-validation`, {
        certificateArn: cert.arn,
        validationRecordFqdns: [cert.domainValidationOptions[0].resourceRecordName]
      }, {
        ...opts,
        dependsOn: [validationDNS]
      });

      albListenerConfig.certificateArn = cert.arn;
      albListenerDependencies.push(certificateValidation);
    };

    new aws.lb.Listener("listener", albListenerConfig, {
      ...opts,
      dependsOn: albListenerDependencies,
    });

    return {
      securityGroupId: albSecurityGroup.id,
      targetGroupArn: albTargetGroup.arn,
      dnsName: alb.dnsName
    }
  }

  /**
   * Create a Service resource with the given unique name, arguments, and options.
   *
   * @param name The _unique_ name of the resource.
   * @param args The arguments to use to populate this resource's properties.
   * @param opts A bag of options that control this resource's behavior.
   */
  constructor(name: string, args: CreateServiceArgs, opts?: pulumi.CustomResourceOptions) {
    super("Service", name);
    this.validateServiceArgs(args);

    this.name = name

    const {
      name: serviceName,
      port,
      image,
      region,
      cpu,
      memory,
      autoscaling,
      hostedZone,
      vpcId,
      subnets,
      tags
    } = args;

    const cluster = new aws.ecs.Cluster(`${name}-cluster`, {
      name: stackName(serviceName),
      tags
    }, {
      ...opts,
      parent: this
    });

    const { securityGroupId: lbSecurityGroupId, targetGroupArn: lbTargetGroupArn, dnsName } = this.createLoadBalancer({
      serviceName,
      hostedZone,
      vpcId,
      subnets,
      tags
    }, {
      ...opts,
      parent: this
    });

    const securityGroup = this.createSecurityGroup({
      serviceName: stackName(serviceName),
      port,
      vpcId,
      lbSecurityGroupId,
      tags
    }, {
      ...opts,
      parent: this
    })

    const taskExecPolicy = new aws.iam.Policy(`${name}-task-exec-policy`, {
      policy: identity.apply(({ accountId }) => JSON.stringify({
        Statement: [
          {
            Action: [
              "logs:CreateLogGroup",
              "logs:CreateLogStream"
            ],
            Resource: [
              `arn:aws:logs:${region}:${accountId}:log-group:awslogs-${stackName(serviceName)}`,
              `arn:aws:logs:${region}:${accountId}:log-group:awslogs-${stackName(serviceName)}:log-stream:*`
            ],
            Effect: "Allow"
          }
        ],
        Version: "2012-10-17"
      })),
      tags
    }, {
      ...opts,
      parent: this
    });

    const role = new aws.iam.Role(`${name}-task-exec-role`, {
      assumeRolePolicy: JSON.stringify({
        Statement: [
          {
            Action: [
              "sts:AssumeRole"
            ],
            Principal: {
              Service: "ecs-tasks.amazonaws.com"
            },
            Effect: "Allow"
          }
        ],
        Version: "2012-10-17"
      }),
      managedPolicyArns: [taskExecPolicy.arn],
      tags
    }, {
      ...opts,
      parent: this
    });

    const taskDefinition = new aws.ecs.TaskDefinition(`${name}-task-definitions`, {
      family: "fargate-task-definition",
      cpu: cpu || "256",
      memory: memory || "512",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      executionRoleArn: role.arn,
      containerDefinitions: JSON.stringify([{
        name: stackName(serviceName),
        image: image,
        portMappings: [{
          containerPort: port,
          hostPort: port,
          protocol: "tcp"
        }],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-create-group": "true",
            "awslogs-group": `awslogs-${stackName(serviceName)}`,
            "awslogs-region": region,
            "awslogs-stream-prefix": `awslogs-${stackName(serviceName)}-${serviceName}`
          }
        },
      }]),
      tags
    }, {
      ...opts,
      parent: this
    });

    // security group rule to enable ALB requests to ECS service port
    new aws.ec2.SecurityGroupRule(`${name}-alb-ecs-egress`, {
      protocol: "tcp",
      type: "egress",
      fromPort: port,
      toPort: port,
      securityGroupId: lbSecurityGroupId,
      sourceSecurityGroupId: securityGroup.id
    }, {
      ...opts,
      parent: this
    });

    const service = new aws.ecs.Service(`${name}-app-service`, {
      cluster: cluster.id,
      launchType: "FARGATE",
      taskDefinition: taskDefinition.arn,
      networkConfiguration: {
        assignPublicIp: true,
        subnets: subnets.map(({ resource }) => resource.id),
        securityGroups: [securityGroup.id],
      },
      waitForSteadyState: false,
      loadBalancers: [{
        targetGroupArn: lbTargetGroupArn,
        containerName: stackName(serviceName),
        containerPort: port
      }],
      tags
    }, {
      ...opts,
      parent: this
    });

    if (autoscaling) {
      const { min, max, cpuAvgThreshold } = autoscaling;
      new aws.appautoscaling.Target(`${name}-scaling-target`, {
        maxCapacity: max,
        minCapacity: min,
        resourceId: pulumi.interpolate`service/${cluster.name}/${service.name}`,
        scalableDimension: "ecs:service:DesiredCount",
        serviceNamespace: "ecs",
      }, {
        ...opts,
        parent: this
      });

      new aws.appautoscaling.Policy(`${name}-scaling-policy`, {
        resourceId: pulumi.interpolate`service/${cluster.name}/${service.name}`,
        policyType: "TargetTrackingScaling",
        scalableDimension: "ecs:service:DesiredCount",
        serviceNamespace: "ecs",
        targetTrackingScalingPolicyConfiguration: {
          targetValue: cpuAvgThreshold || 75, // % CPU utilization
          predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageCPUUtilization",
          },
        },
      }, {
        ...opts,
        parent: this
      });

    }

    this.url = hostedZone ? `https://${stackName(serviceName)}.${hostedZone}` : pulumi.interpolate`http://${dnsName}`
  }
}