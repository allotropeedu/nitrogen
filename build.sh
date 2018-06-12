#!/bin/bash

set -e

rm -rf backend/app-temp
mkdir backend/app-temp
ng build --prod --aot --output-path backend/app-temp/
rm -rf backend/app
mv backend/app-temp backend/app
