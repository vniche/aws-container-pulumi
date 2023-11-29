# aws-container-pulumi

A Pulumi NPM library to ease serverless (Fargate-backed) ECS service resources setup on AWS

## Install

To install this library you can use eithe `pnpm` or `yarn` as your would for any other Node library:

```shell
# pnpm
pnpm install @vniche/aws-container-pulumi @vniche/aws-vpc-pulumi

# yarn
yarn add @vniche/aws-container-pulumi @vniche/aws-vpc-pulumi
```

## Usage

To use this library import on your (node-based, of course) Pulumi program code. Here are some example of setups:

### ECS serverless service

```typescript
import { Network } from "@vniche/aws-vpc-pulumi";
import { Service } from "@vniche/aws-container-pulumi";

const { vpcId, subnets } = new Network({
    ...
});

const service = new Service("service", {
    name: "nginx",
    image: "nginx:latest",
    port: 80,
    hostedZone: "labs.vniche.me",
    cpu: "256",
    memory: "512",
    autoscaling: {
        min: 1,
        max: 5,
        cpuAvgThreshold: 50
    },
    subnets: subnets,
    vpcId: vpcId,
    region,
    tags
});

// Stack exports
export const url = service.url;
```

## Future

For the future, I plan to add support for:

- [Scheduled tasks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/scheduled_tasks.html).
- ECS with internal Load Balancer

Also, let me know if you're missing something, found any bugs or have any questions by creating an [issue](https://github.com/vniche/aws-container-pulumi/issues).
