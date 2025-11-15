#!/bin/bash
###############################################################################
# Fast Incremental Build for N8N Custom Image
#
# This script performs an incremental build WITHOUT cleanup, making it
# 3-5x faster than build-local.sh for iterative development.
#
# Features:
#   - Skips cleanup (preserves compiled directory)
#   - Only runs pnpm install if lockfile changed
#   - Uses turbo cache for incremental builds
#   - Leverages Docker layer caching
#
# Output: brackett-n8n:local
#
# Usage:
#   ./build-local-fast.sh
#
# When to use this vs build-local.sh:
#   - Use THIS for quick iterations (changed a few files)
#   - Use build-local.sh for clean builds or major changes
###############################################################################

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ ${1}${NC}"; }
log_success() { echo -e "${GREEN}✅ ${1}${NC}"; }
log_error() { echo -e "${RED}❌ ${1}${NC}"; }
log_skip() { echo -e "${CYAN}⏭️  ${1}${NC}"; }
log_warn() { echo -e "${YELLOW}⚠️  ${1}${NC}"; }

IMAGE_NAME="brackett-n8n:local"
LOCKFILE_CHECKSUM_FILE=".build-cache/lockfile.md5"

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║    Fast Incremental Build (Development Mode)      ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

# Check prerequisites
if ! command -v pnpm &> /dev/null; then
    log_error "pnpm is not installed"
    exit 1
fi

if ! command -v docker &> /dev/null; then
    log_error "docker is not installed"
    exit 1
fi

if [ ! -f "package.json" ]; then
    log_error "Run this script from n8n repository root"
    exit 1
fi

# Create cache directory if it doesn't exist
mkdir -p .build-cache

log_info "Starting fast incremental build..."
log_info "Image: ${IMAGE_NAME}"
echo ""

# Start timer
START_TIME=$(date +%s)

# ============================================================
# Step 1: Check if dependencies changed
# ============================================================
echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}Step 1: Checking dependencies${NC}"
echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"

if [ -f "pnpm-lock.yaml" ]; then
    CURRENT_CHECKSUM=$(md5sum pnpm-lock.yaml | awk '{print $1}')

    if [ -f "$LOCKFILE_CHECKSUM_FILE" ]; then
        CACHED_CHECKSUM=$(cat "$LOCKFILE_CHECKSUM_FILE")

        if [ "$CURRENT_CHECKSUM" == "$CACHED_CHECKSUM" ]; then
            log_skip "Dependencies unchanged, skipping pnpm install"
            SKIP_INSTALL=true
        else
            log_info "Dependencies changed, will run pnpm install"
            SKIP_INSTALL=false
        fi
    else
        log_info "No cache found, will run pnpm install"
        SKIP_INSTALL=false
    fi
else
    log_error "pnpm-lock.yaml not found"
    exit 1
fi

# ============================================================
# Step 2: Install dependencies (if needed)
# ============================================================
if [ "$SKIP_INSTALL" != true ]; then
    echo ""
    echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"
    echo -e "${BLUE}Step 2: Installing dependencies${NC}"
    echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"

    log_info "Running pnpm install..."
    pnpm install

    # Save checksum for next run
    echo "$CURRENT_CHECKSUM" > "$LOCKFILE_CHECKSUM_FILE"
    log_success "Dependencies installed"
else
    echo ""
    echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"
    echo -e "${BLUE}Step 2: Installing dependencies${NC}"
    echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"
    log_skip "Skipping pnpm install (dependencies unchanged)"
fi

# ============================================================
# Step 3: Incremental build
# ============================================================
echo ""
echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}Step 3: Building packages (incremental)${NC}"
echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"

log_info "Running pnpm build (turbo will cache unchanged packages)..."
pnpm build

log_success "Package build completed"

# ============================================================
# Step 4: Prepare compiled directory
# ============================================================
echo ""
echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}Step 4: Preparing deployment${NC}"
echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"

# Check if compiled directory exists from previous build
if [ -d "compiled" ]; then
    log_info "Compiled directory exists, will update incrementally"
else
    log_info "No compiled directory found, will create fresh"
fi

# Run the deployment preparation
log_info "Running deployment preparation..."
node scripts/build-n8n.mjs

log_success "Deployment preparation completed"

# ============================================================
# Step 5: Build Docker image with cache
# ============================================================
echo ""
echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}Step 5: Building Docker image (with cache)${NC}"
echo -e "${GRAY}─────────────────────────────────────────────────────${NC}"

log_info "Building Docker image (leveraging cache layers)..."

# Check if image exists for cache
if docker image inspect "$IMAGE_NAME" &> /dev/null; then
    log_info "Using existing image as cache: $IMAGE_NAME"
    CACHE_FROM_ARG="--cache-from=$IMAGE_NAME"
else
    log_warn "No existing image found, building without cache"
    CACHE_FROM_ARG=""
fi

# Build with environment variables for image name
IMAGE_BASE_NAME="brackett-n8n" \
IMAGE_TAG="local" \
node scripts/dockerize-n8n.mjs

log_success "Docker image built successfully"

# ============================================================
# Summary
# ============================================================
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
MINUTES=$((ELAPSED / 60))
SECONDS=$((ELAPSED % 60))

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║              ✅ FAST BUILD SUCCESS                 ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""
log_success "Image ready: ${IMAGE_NAME}"
log_info "Build time: ${MINUTES}m ${SECONDS}s"
echo ""
log_info "To use this image, update your docker-compose.yml:"
echo -e "${GRAY}    image: ${IMAGE_NAME}${NC}"
echo ""
log_info "To force a clean build, use: ./build-local.sh"
echo ""
