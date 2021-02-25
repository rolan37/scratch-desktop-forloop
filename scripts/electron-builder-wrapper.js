/**
 * @overview This script runs `electron-builder` with special management of code signing configuration on Windows.
 * Running this script with no command line parameters should build all targets for the current platform.
 * On Windows, make sure to set CSC_* or WIN_CSC_* environment variables or the NSIS build will fail.
 * On Mac, the CSC_* variables are optional but will be respected if present.
 * See also: https://www.electron.build/code-signing
 */

const {spawnSync} = require('child_process');
const fs = require('fs');

/**
 * Strip any code signing configuration (CSC) from a set of environment variables.
 * @param {object} environment - a collection of environment variables which might include code signing configuration.
 * @returns {object} - a collection of environment variables which does not include code signing configuration.
 */
const stripCSC = function (environment) {
    const {
        CSC_LINK: _CSC_LINK,
        CSC_KEY_PASSWORD: _CSC_KEY_PASSWORD,
        WIN_CSC_LINK: _WIN_CSC_LINK,
        WIN_CSC_KEY_PASSWORD: _WIN_CSC_KEY_PASSWORD,
        ...strippedEnvironment
    } = environment;
    return strippedEnvironment;
};

/**
 * @returns {string} - an `electron-builder` flag to build for the current platform, based on `process.platform`.
 */
const getPlatformFlag = function () {
    switch (process.platform) {
    case 'win32': return '--windows';
    case 'darwin': return '--macos';
    case 'linux': return '--linux';
    }
    throw new Error(`Could not determine platform flag for platform: ${process.platform}`);
};

/**
 * Tests if the target name is of the given target type.
 * @param {string} targetName - the target name to test, like 'nsis' or 'dmg:arm64'
 * @param {string} targetType - the target type to look for, such as 'nsis' or 'dmg'
 * @returns {boolean} - true if `targetName` is exactly `targetType` or starts with `targetType` followed by ':'.
 */
const isTargetOfType = function (targetName, targetType) {
    return targetName === targetType ||
        targetName.indexOf(`${targetType}:`) === 0;
};

/**
 * Run `electron-builder` once to build one or more target(s).
 * @param {object} wrapperConfig - overall configuration object for the wrapper script.
 * @param {object} target - the target to build in this call.
 * If the `target.name` is `'nsis'` then the environment must contain code-signing config (CSC_* or WIN_CSC_*).
 * If the `target.name` is `'appx'` then code-signing config will be stripped from the environment if present.
 */
const runBuilder = function (wrapperConfig, target) {
    // the AppX build fails if CSC_* or WIN_CSC_* variables are set
    const shouldStripCSC = isTargetOfType(target.name, 'appx') || (!wrapperConfig.doSign);
    const childEnvironment = shouldStripCSC ? stripCSC(process.env) : process.env;
    if (wrapperConfig.doSign &&
        isTargetOfType(target.name, 'nsis') &&
        !(childEnvironment.CSC_LINK || childEnvironment.WIN_CSC_LINK)) {
        throw new Error(`Signing NSIS build requires CSC_LINK or WIN_CSC_LINK`);
    }
    const platformFlag = getPlatformFlag();
    let allArgs = [platformFlag, target.name];
    if (target.platform === 'darwin') {
        allArgs.push(`--c.mac.type=${wrapperConfig.mode === 'dist' ? 'distribution' : 'development'}`);
        if (isTargetOfType(target.name, 'mas-dev')) {
            allArgs.push('--c.mac.provisioningProfile=mas-dev.provisionprofile');
        }
        if (wrapperConfig.doSign) {
            // really this is "notarize only if we also sign"
            allArgs.push('--c.afterSign=scripts/afterSign.js');
        } else {
            allArgs.push('--c.mac.identity=null');
        }
    }
    if (!wrapperConfig.doPackage) {
        allArgs.push('--dir', '--c.compression=store');
    }
    allArgs = allArgs.concat(wrapperConfig.builderArgs);
    console.log(`running electron-builder with arguments: ${allArgs}`);
    const result = spawnSync('electron-builder', allArgs, {
        env: childEnvironment,
        shell: true,
        stdio: 'inherit'
    });
    if (result.error) {
        throw result.error;
    }
    if (result.signal) {
        throw new Error(`Child process terminated due to signal ${result.signal}`);
    }
    if (result.status) {
        throw new Error(`Child process returned status code ${result.status}`);
    }
};

/**
 * Build a platform+target object from the parameters. This object represents one call to electron-builder and will
 * build one platform+target, potentially for multiple architectures.
 * @param {Array.<object>} targets - the list to which new target objects will be added
 * @property {string} name - the 'target' combined with each of the items from the 'architectures' argument
 * @property {string} platform - the 'platform' argument
 * @param {string} newPlatform - the electron-builder platform name ('win32', 'darwin', etc.)
 * @param {string} newTarget - the electron-builder target name ('mas', 'nsis', etc.)
 * @param {Array.<string>} newArchitectures - the electron-builder architecture names ('x64', 'ia32', etc.)
 */
const addPlatformTarget = function (targets, newPlatform, newTarget, newArchitectures = null) {
    const newEntry = {
        platform: newPlatform,
        name: newArchitectures.map(arch => `${newTarget}:${arch}`).join(' ') // 'dmg:x64 dmg:arm64'
    };
    targets.push(newEntry);
};

/**
 * @param {object} wrapperConfig - overall configuration object for the wrapper script.
 * @returns {Array.<object>} - the default list of targets on this platform. Each item in the array represents one
 * call to `runBuilder` for exactly one build target. In theory electron-builder can build two or more targets at the
 * same time but doing so limits has unwanted side effects on both macOS and Windows (see function body).
 */
const calculateTargets = function (wrapperConfig) {
    const masDevProfile = 'mas-dev.provisionprofile';
    const targets = [];
    switch (process.platform) {
    case 'win32':
        // Run in two passes so we can skip signing the AppX for distribution through the MS Store.
        addPlatformTarget(targets, 'win32', 'appx', ['x64', 'ia32', 'arm64']);
        addPlatformTarget(targets, 'win32', 'nsis', ['ia32']);
        break;
    case 'darwin':
        // Running 'dmg' and 'mas' in the same pass causes electron-builder to skip signing the non-MAS app copy.
        // Running them as separate passes means they can both get signed.
        // Seems like a bug in electron-builder...
        // Running the 'mas' build first means that its output is available while we wait for 'dmg' notarization.
        // Add macAppStoreDev here to test a MAS-like build locally. You'll need a Mac Developer provisioning profile.
        if (fs.existsSync(masDevProfile)) {
            addPlatformTarget(targets, 'darwin', 'mas-dev', ['x64', 'arm64']);
        } else {
            console.log(`skipping 'mas-dev' targets: ${masDevProfile} missing`);
        }
        if (wrapperConfig.doSign) {
            addPlatformTarget(targets, 'darwin', 'mas', ['x64', 'arm64']);
        } else {
            // electron-builder doesn't seem to support this configuration even if mac.type is "development"
            console.log(`skipping 'mas' targets: code-signing is disabled`);
        }
        addPlatformTarget(targets, 'darwin', 'dmg', ['x64', 'arm64']);
        break;
    default:
        throw new Error(`Could not determine targets for platform: ${process.platform}`);
    }
    return targets;
};

const parseArgs = function () {
    const scriptArgs = process.argv.slice(2); // remove `node` and `this-script.js`
    const builderArgs = [];
    let mode = 'dev'; // default

    for (const arg of scriptArgs) {
        const modeSplit = arg.split(/--mode(\s+|=)/);
        if (modeSplit.length === 3) {
            mode = modeSplit[2];
        } else {
            builderArgs.push(arg);
        }
    }

    let doPackage;
    let doSign;

    switch (mode) {
    case 'dev':
        doPackage = true;
        doSign = false;
        break;
    case 'dir':
        doPackage = false;
        doSign = false;
        break;
    case 'dist':
        doPackage = true;
        doSign = true;
    }

    return {
        builderArgs,
        doPackage, // false = build to directory
        doSign,
        mode
    };
};

const main = function () {
    const wrapperConfig = parseArgs();

    // TODO: allow user to specify targets? We could theoretically build NSIS on Mac, for example.
    wrapperConfig.targets = calculateTargets(wrapperConfig);

    for (const target of wrapperConfig.targets) {
        runBuilder(wrapperConfig, target);
    }
};

main();
