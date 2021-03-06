const {notarize} = require('electron-notarize');

const notarizeMacBuild = async function (context) {
    // keep this in sync with appId in the electron-builder config
    const appId = 'edu.mit.scratch.scratch-desktop';

    if (!process.env.AC_USERNAME) {
        console.error([
            'This build is not notarized and will not run on newer versions of macOS!',
            'Notarizing the macOS build requires an Apple ID. To notarize future builds:',
            '* Set the environment variable AC_USERNAME to your@apple.id and',
            '* Either set AC_PASSWORD or ensure your keychain has an item for "Application Loader: your@apple.id"'
        ].join('\n'));
        return;
    }

    const appleId = process.env.AC_USERNAME;
    const appleIdKeychainItem = `Application Loader: ${appleId}`;

    if (process.env.AC_PASSWORD) {
        console.log(`Notarizing with Apple ID "${appleId}" and a password`);
    } else {
        console.log(`Notarizing with Apple ID "${appleId}" and keychain item "${appleIdKeychainItem}"`);
    }

    const {appOutDir} = context;
    const productFilename = context.packager.appInfo.productFilename;
    await notarize({
        appBundleId: appId,
        appPath: `${appOutDir}/${productFilename}.app`,
        appleId,
        appleIdPassword: process.env.AC_PASSWORD || `@keychain:${appleIdKeychainItem}`
    });
};

const afterSign = async function (context) {
    // WARNING: this assumes all targets have the same notarization requirements as the first
    // this is fine if you (for example) run DMG for x64 and arm64 together, but run MAS separately
    const firstTargetName = context.targets[0].name;
    switch (firstTargetName) {
    case 'mas-dev': // unpacked macOS dev/test build simulating MAS
    case 'mas': // macOS build for Mac App Store
        break;
    case 'dmg': // macOS build NOT for Mac App Store
        await notarizeMacBuild(context);
        break;
    }
};

module.exports = afterSign;
