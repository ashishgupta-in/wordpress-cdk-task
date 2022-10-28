#!/bin/bash

# Set the environment variables
set -a && source .env && set +a

# Deploy
npx cdk deploy --require-approval never