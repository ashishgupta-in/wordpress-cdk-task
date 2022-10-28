#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WordpressAppStack } from '../lib/wordpress-app-stack';

const app = new cdk.App();
new WordpressAppStack(app, 'WordpressAppStack', {
  env: {
    account: process.env.CDK_DEPLOY_ACCOUNT,
    region: process.env.CDK_DEPLOY_REGION
  }
});