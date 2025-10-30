#!/bin/bash
###############################################################################
# Build and Push N8N Custom Image to Google Container Registry (GCR)
#
# Usage:
#   ./build-gcp.sh <version> [platform]
#
# Arguments:
#   version  - Version tag (required)
#   platform - Target platform (optional, default: amd64)
#              Options: amd64, arm64, both
#
# Examples:
#   ./build-gcp.sh v1.0.0              # Build for amd64 only
#   ./build-gcp.sh v1.0.0 amd64        # Build for amd64 only
#   ./build-gcp.sh v1.0.0 arm64        # Build for arm64 only
#   ./build-gcp.sh v1.0.0 both         # Build for both platforms
#   ./build-gcp.sh $(git rev-parse --short HEAD) both
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
    echo "Usage: $0 <version> [platform]"
    echo ""
    echo "Arguments:"
    echo "  version  - Version tag (required)"
    echo "  platform - Target platform (optional, default: amd64)"
    echo "             Options: amd64, arm64, both"
    echo ""
    echo "Examples:"
    echo "  $0 v1.0.0              # Build for amd64 only"
    echo "  $0 v1.0.0 amd64        # Build for amd64 only"
    echo "  $0 v1.0.0 arm64        # Build for arm64 only"
    echo "  $0 v1.0.0 both         # Build for both platforms"
    exit 1
fi

VERSION=$1
PLATFORM_ARG=${2:-amd64}

# Validate and set platform
case "$PLATFORM_ARG" in
    amd64)
        DOCKER_PLATFORM="linux/amd64"
        PLATFORM_DESC="linux/amd64"
        ;;
    arm64)
        DOCKER_PLATFORM="linux/arm64"
        PLATFORM_DESC="linux/arm64"
        ;;
    both)
        DOCKER_PLATFORM="linux/amd64,linux/arm64"
        PLATFORM_DESC="linux/amd64, linux/arm64"
        ;;
    *)
        log_error "Invalid platform: $PLATFORM_ARG"
        echo "Valid options: amd64, arm64, both"
        exit 1
        ;;
esac
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

log_info "Building Docker image: ${FULL_IMAGE_NAME}"
log_info "Platform(s): ${PLATFORM_DESC}"
echo ""

# Ensure buildx is available
log_info "Setting up Docker buildx..."
docker buildx create --use --name n8n-builder --driver docker-container 2>/dev/null || docker buildx use n8n-builder 2>/dev/null || true

# Configure Docker auth for GCR (needs to be done before buildx push)
log_info "Configuring Docker authentication for GCR..."
gcloud auth configure-docker gcr.io --quiet

# Build the app first (required before Docker build)
log_info "Building n8n application..."
pnpm run build:n8n

if [ $? -ne 0 ]; then
    log_error "Application build failed"
    exit 1
fi

log_success "Application build completed"
echo ""

# Build and push Docker image
if [ "$PLATFORM_ARG" = "both" ]; then
    log_info "Building and pushing multi-platform Docker image..."
    log_warning "This may take 10-15 minutes as it builds for both architectures"
else
    log_info "Building and pushing Docker image for ${PLATFORM_DESC}..."
fi

docker buildx build \
    --platform "${DOCKER_PLATFORM}" \
    -t "${FULL_IMAGE_NAME}" \
    -t "${LATEST_IMAGE_NAME}" \
    -f docker/images/n8n/Dockerfile \
    --push \
    .

if [ $? -ne 0 ]; then
    log_error "Docker build and push failed"
    exit 1
fi

log_success "Pushed ${VERSION} (${PLATFORM_DESC})"
log_success "Pushed latest (${PLATFORM_DESC})"

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║              ✅ PUSH SUCCESSFUL                    ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""
log_info "Images pushed:"
echo "  • ${FULL_IMAGE_NAME}"
echo "  • ${LATEST_IMAGE_NAME}"
echo ""
