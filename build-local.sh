#!/bin/bash
###############################################################################
# Build N8N Custom Image for Local Development
#
# This builds your n8n fork as: brackett-n8n:local
# Use this image in your brackett docker-compose.yml for local testing
#
# Usage:
#   ./build-local.sh
###############################################################################

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ ${1}${NC}"; }
log_success() { echo -e "${GREEN}✅ ${1}${NC}"; }
log_error() { echo -e "${RED}❌ ${1}${NC}"; }

IMAGE_NAME="brackett-n8n:local"

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║     Build N8N Custom Image (Local Development)    ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

# Check prerequisites
if ! command -v pnpm &> /dev/null; then
    log_error "pnpm is not installed"
    exit 1
fi

if [ ! -f "package.json" ]; then
    log_error "Run this script from n8n repository root"
    exit 1
fi

log_info "Building n8n application and Docker image..."
log_info "Image: ${IMAGE_NAME}"
echo ""

# Build using n8n's build script with custom image name
IMAGE_BASE_NAME="brackett-n8n" \
IMAGE_TAG="local" \
pnpm build:docker

if [ $? -eq 0 ]; then
    echo ""
    echo "╔════════════════════════════════════════════════════╗"
    echo "║                  ✅ BUILD SUCCESS                  ║"
    echo "╚════════════════════════════════════════════════════╝"
    echo ""
    log_success "Image ready: ${IMAGE_NAME}"
else
    log_error "Build failed"
    exit 1
fi
