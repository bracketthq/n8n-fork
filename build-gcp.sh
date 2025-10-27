#!/bin/bash
###############################################################################
# Build and Push N8N Custom Image to Google Container Registry (GCR)
#
# Usage:
#   ./build-gcp.sh <version>
#
# Examples:
#   ./build-gcp.sh v1.0.0
#   ./build-gcp.sh $(git rev-parse --short HEAD)
###############################################################################

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ ${1}${NC}"; }
log_success() { echo -e "${GREEN}✅ ${1}${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  ${1}${NC}"; }
log_error() { echo -e "${RED}❌ ${1}${NC}"; }

# ============================================================================
# CONFIGURATION - Update these values
# ============================================================================
GCP_PROJECT_ID="strategic-volt-464918-c4"
IMAGE_NAME="brackett-n8n"

# ============================================================================

if [ $# -eq 0 ]; then
    log_error "Version argument required"
    echo "Usage: $0 <version>"
    echo "Example: $0 v1.0.0"
    exit 1
fi

VERSION=$1
FULL_IMAGE_NAME="gcr.io/${GCP_PROJECT_ID}/${IMAGE_NAME}:${VERSION}"
LATEST_IMAGE_NAME="gcr.io/${GCP_PROJECT_ID}/${IMAGE_NAME}:latest"

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║       Build & Push N8N to GCR                     ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

# Check prerequisites
if ! command -v pnpm &> /dev/null; then
    log_error "pnpm is not installed"
    exit 1
fi

if ! command -v gcloud &> /dev/null; then
    log_error "gcloud CLI is not installed"
    exit 1
fi

if [ ! -f "package.json" ]; then
    log_error "Run this script from n8n repository root"
    exit 1
fi

log_info "Building image: ${FULL_IMAGE_NAME}"
echo ""

# Build with GCR tag
IMAGE_BASE_NAME="gcr.io/${GCP_PROJECT_ID}/${IMAGE_NAME}" \
IMAGE_TAG="${VERSION}" \
pnpm build:docker

if [ $? -ne 0 ]; then
    log_error "Build failed"
    exit 1
fi

log_success "Build completed"
echo ""

# Configure Docker auth for GCR
log_info "Configuring Docker authentication for GCR..."
gcloud auth configure-docker gcr.io --quiet

# Push versioned image
log_info "Pushing ${FULL_IMAGE_NAME}..."
docker push "${FULL_IMAGE_NAME}"

if [ $? -ne 0 ]; then
    log_error "Failed to push image"
    exit 1
fi

log_success "Pushed ${VERSION}"

# Tag and push as latest
log_info "Tagging and pushing as latest..."
docker tag "${FULL_IMAGE_NAME}" "${LATEST_IMAGE_NAME}"
docker push "${LATEST_IMAGE_NAME}"

log_success "Pushed latest"

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║              ✅ PUSH SUCCESSFUL                    ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""
log_info "Images pushed:"
echo "  • ${FULL_IMAGE_NAME}"
echo "  • ${LATEST_IMAGE_NAME}"
echo ""
