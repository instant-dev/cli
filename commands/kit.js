const { Command } = require('cmnd');
const colors = require('colors/safe');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const Instant = require('@instant.dev/orm')();

const checkMigrationState = require('../helpers/check_migration_state.js');

class KitCommand extends Command {

  constructor() {
    super('kit');
  }

  help () {
    return {
      description: 'Installs a kit',
      args: ['kit'],
      flags: {},
      vflags: {}
    };
  }

  determineFramework () {
    if (fs.existsSync('.vercel')) {
      return 'vercel';
    } else if (fs.existsSync('stdlib.json')) {
      return 'autocode';
    } else {
      return 'default';
    }
  }

  readRecursive (root, pathname = '', files = {}) {
    let filenames = fs.readdirSync(path.join(root, pathname));
    filenames.forEach(filename => {
      let filepath = [pathname, filename].join('/');
      let fullpath = path.join(root, filepath);
      let stat = fs.statSync(fullpath);
      if (stat.isDirectory()) {
        this.readRecursive(root, filepath, files);
      } else {
        files[filepath] = fs.readFileSync(fullpath);
      }
    });
    return files;
  }

  writeFile (filename, buffer) {
    let paths = filename.split('/').slice(1, -1);
    for (let i = 1; i <= paths.length; i++) {
      let pathname = paths.slice(0, i).join('/');
      if (!fs.existsSync(pathname)) {
        fs.mkdirSync(pathname);
      }
    }
    fs.writeFileSync(path.join('.', filename), buffer);
  }

  async validateKit (name) {
    let kit = {
      name: (name || '').trim(),
      framework: this.determineFramework(),
      migrations: {},
      models: {},
      files: {},
      dependencies: {}
    };
    const kitListRoot = path.join(__dirname, '..', 'kits');
    const kits = fs.readdirSync(kitListRoot);
    if (!kit.name) {
      throw new Error(`Please provide a valid kit name.\nValid kits are: ${kits.join(', ')}`);
    } else if (kits.indexOf(kit.name) === -1) {
      throw new Error(`Kit "${kit.name}" not found.\nValid kits are: ${kits.join(', ')}`);
    }
    const kitRoot = path.join(kitListRoot, kit.name);
    const migrationsRoot = path.join(kitRoot, 'migrations');
    const modelsRoot = path.join(kitRoot, 'models');
    const filesRoot = path.join(kitRoot, 'files', kit.framework);
    const depsPath = path.join(kitRoot, 'dependencies.json');
    if (fs.existsSync(migrationsRoot)) {
      try {
        kit.migrations = fs.readdirSync(migrationsRoot)
          .map(filename => {
            let file = fs.readFileSync(path.join(migrationsRoot, filename));
            return JSON.parse(file.toString());
          });
      } catch (e) {
        throw new Error(`Invalid migrations in "${modelsRoot}":\n${e.message}`);
      }
    }
    if (fs.existsSync(modelsRoot)) {
      try {
        kit.models = fs.readdirSync(modelsRoot)
          .reduce((m, filename) => {
            m[filename] = fs.readFileSync(path.join(modelsRoot, filename));
            m[filename] = m[filename].toString();
            return m;
          }, {});
      } catch (e) {
        throw new Error(`Invalid models in "${modelsRoot}":\n${e.message}`);
      }
    }
    if (fs.existsSync(filesRoot)) {
      kit.files = this.readRecursive(filesRoot);
    }
    if (fs.existsSync(depsPath)) {
      let deps = fs.readFileSync(depsPath);
      try {
        kit.dependencies = JSON.parse(deps.toString());
      } catch (e) {
        throw new Error(`Invalid dependencies in "${depsPath}":\n${e.message}`);
      }
    }
    return kit;
  }

  async run (params) {

    const environment = process.env.NODE_ENV || 'development';
    if (environment !== 'development') {
      throw new Error(`This command can only be used when process.env.NODE_ENV=development`);
    }

    if (!Instant.isFilesystemInitialized()) {
      throw new Error(
        `Instant.dev has not yet been initialized in "${Instant.filesystemRoot()}".\n\n` +
        `Please first initialize with:\n\n` +
        colors.grey.bold(`\t$ instant init`)
      );
    }

    console.log();
    console.log(colors.bold.black(`Installing: `) + `kit "${colors.bold.green(params.args[0] || '')}"...`);
    console.log();

    Instant.enableLogs(2);
    await Instant.connect();
    Instant.Migrator.enableDangerous();
    let canMigrate = await checkMigrationState(Instant);
    if (!canMigrate) {
      throw new Error(`Your migration state must be up to date to install a kit`);
    }

    const kit = await this.validateKit(params.args[0]);

    // Write boilerplate from kit and install dependencies
    const packagePath = path.join(process.cwd(), 'package.json');
    const pkg = {
      name: 'new-instant-project',
      version: '0.0.0',
      dependencies: {}
    };
    if (fs.existsSync(packagePath)) {
      let readPackage = fs.readFileSync(packagePath);
      try {
        readPackage = JSON.parse(readPackage);
      } catch (e) {
        throw new Error(`Could not read "package.json":\n${e.message}`);
      }
      Object.keys(readPackage).forEach(key => {
        pkg[key] = readPackage[key];
      });
    }

    for (const migrationJSON of kit.migrations) {
      let migration = await Instant.Migrator.createFromTemplate(migrationJSON);
      Instant.Migrator.Dangerous.filesystem.write(migration);
    }
    for (const filename in kit.models) {
      let model = kit.models[filename];
      Instant.Generator.write(filename, model);
    }
    for (const filename in kit.files) {
      console.log(colors.bold.black(`FrameworkFileWriter:`) +  ` Writing file "${filename}" for framework "${kit.framework}" ...`);
      this.writeFile(filename, kit.files[filename]);
    }
    for (const key in kit.dependencies) {
      pkg.dependencies[key] = kit.dependencies[key];
    }

    // Run any new migrations
    if (kit.migrations.length) {
      await Instant.Migrator.Dangerous.migrate();
    }

    Instant.Migrator.disableDangerous();
    Instant.disconnect();

    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
    let deps = Object.keys(pkg.dependencies);
    if (deps.length > 0) {
      console.log();
      console.log(colors.bold.black(`Installing: `) + `"package.json" dependencies "${deps.join(", ")}"`);
      childProcess.execSync(`npm i`, {stdio: 'inherit'});
    }
    if ('link' in params.vflags) {
      console.log();
      console.log(colors.bold.black(`Installing: `) + `Linking @instant.dev/orm ...`);
      childProcess.execSync(`npm link @instant.dev/orm`, {stdio: 'inherit'});
    }

    console.log();
    console.log(`${colors.bold.green('Success:')} Kit "${colors.bold.green(kit.name)}" installed successfully for framework "${colors.bold.green(kit.framework)}"!`);
    console.log();

    return void 0;

  }

}

module.exports = KitCommand;
