#!/usr/bin/env node
import yargs from "yargs";
import { exec } from "child_process";
import { promises } from "fs";
import { promisify } from "util";
import globpkg from "glob";
const { glob } = globpkg;
import rimraf from "rimraf";
const execPromise = promisify(exec);
const rimrafPromise = promisify(rimraf);
const globPromise = promisify(glob);
import { join, relative, dirname } from "path";

const options = {
  "proto-pattern": {
    type: "string",
    default: "./proto/**/*.proto",
    describe: "Proto files search pattern",
  },
  "enable-cjs": {
    type: "boolean",
    default: false,
    describe: "Enable new .cjs .mjs naming pattern to support es6 modules",
  },
  includes: {
    type: "array",
    default: ["proto"],
    describe: "Proto include paths used in generation",
  },
} as const;

function template(out: string) {
  return (s: string) => new Function("return `" + s + "`;").call({ out });
}

type OptionList = string[];
interface ProtocTaskOptions {
  protoCmd: OptionList[];
  protoPattern: string;
  out: string;
  includes: string[] | readonly ["proto"];
}
async function protocTask({
  protoCmd,
  protoPattern,
  out,
  includes,
}: ProtocTaskOptions) {
  const files = await globPromise(protoPattern);
  await rimrafPromise(out);
  await promises.mkdir(out);
  const includeOpts = includes.map((v) => `-I${v}`);
  for (const p of protoCmd) {
    await execPromise(
      ["protoc", ...includeOpts, ...p.map(template(out)), ...files].join(" ")
    );
  }
}

interface PostProcessOptions {
  onDone?: (
    opts: PostProcessOptions & ProtocTaskOptions
  ) => Promise<void> | void;
  enableCjs?: boolean;
}
type NameOptsTuple =
  | [string, OptionList[]]
  | [string, OptionList[], PostProcessOptions];

async function postProcess(
  postProcessOptions: PostProcessOptions & ProtocTaskOptions
) {
  const { onDone } = postProcessOptions;
  if (onDone) {
    await onDone(postProcessOptions);
  }
}

async function renameCommonJsFiles(out: string) {
  const cwd = join(process.cwd(), out);
  const files = await globPromise("**/*_pb.js", { cwd });
  await Promise.all(
    files.map((f) =>
      promises.rename(join(cwd, f), join(cwd, f.slice(0, -2) + "cjs"))
    )
  );
}

async function renameCommonDtsFiles(out: string) {
  const cwd = join(process.cwd(), out);
  const files = await globPromise("**/*_pb.d.ts", { cwd });
  await Promise.all(
    files.map((f) =>
      promises.rename(join(cwd, f), join(cwd, f.slice(0, -4) + "d.cts"))
    )
  );
}

async function fixCommonJsImportsInFile(file: string, cjsFiles: string[]) {
  const d = dirname(file);
  const replace = cjsFiles
    .map((c) => relative(d, c))
    .map((rel) => (dirname(rel) === "." ? "./" + rel : rel));
  const contents = await promises.readFile(file);
  const replacedContents = contents
    .toString()
    .split("\n")
    .map((l) => {
      replace.forEach((f) => {
        l = l.replace(`'${f.slice(0, -4)}'`, `'${f}'`);
        l = l.replace(`'${f.slice(0, -3) + "js"}'`, `'${f}'`);
      });
      return l;
    })
    .join("\n");

  await promises.writeFile(file, replacedContents);
}

async function fixCommonJsImportsInDir(cwd: string, cjsFiles: string[]) {
  await promises
    .readdir(cwd)
    .then((files) => files.map((f) => join(cwd, f)))
    .then((files) =>
      files.map((f) => promises.stat(f).then((st) => ({ f, st })))
    )
    .then((files) => Promise.all(files))
    .then((files) =>
      files.map(({ f, st }) =>
        st.isDirectory()
          ? fixCommonJsImportsInDir(f, cjsFiles)
          : fixCommonJsImportsInFile(f, cjsFiles)
      )
    )
    .then((files) => Promise.all(files));
}

async function fixCommonJsImports(out: string) {
  const cwd = join(process.cwd(), out);
  const files = await globPromise("**/*_pb.cjs", { cwd });
  await fixCommonJsImportsInDir(
    cwd,
    files.map((f) => join(cwd, f))
  );
}

async function onCommonJSDone(opts: PostProcessOptions & ProtocTaskOptions) {
  if (!opts.enableCjs) return;
  const { out } = opts;
  await renameCommonJsFiles(out);
  await renameCommonDtsFiles(out);
  await fixCommonJsImports(out);
}

const genSettigns: Array<NameOptsTuple> = [
  [
    "ts/node",
    [
      [
        "--js_out=import_style=commonjs,binary:${this.out}",
        "--grpc_out=grpc_js:${this.out}",
        "--plugin=protoc-gen-grpc=./node_modules/.bin/grpc_tools_node_protoc_plugin",
      ],
      [
        "--plugin=protoc-gen-ts=./node_modules/.bin/protoc-gen-ts",
        "--ts_out=grpc_js:${this.out}",
      ],
    ],
    { onDone: onCommonJSDone },
  ],
  [
    "ts/web",
    [
      [
        "--js_out=import_style=commonjs:${this.out}",
        "--plugin=protoc-gen-grpc=./node_modules/.bin/",
        "--grpc-web_out=import_style=commonjs+dts,mode=grpcwebtext:${this.out}",
      ],
    ],
    { onDone: onCommonJSDone },
  ],
  [
    "go",
    [
      [
        "--go_out=${this.out}",
        "--go_opt=paths=source_relative",
        "--go-grpc_out=${this.out}",
        "--go-grpc_opt=paths=source_relative",
      ],
    ],
  ],
];

Promise.resolve(yargs(process.argv.slice(2)).options(options).argv)
  .then((args) =>
    Promise.all(
      genSettigns.map(([out, protoCmd, postProcessOptions]) =>
        protocTask({
          ...args,
          protoCmd,
          out,
          protoPattern: args["proto-pattern"],
        }).then(() =>
          postProcess({
            ...args,
            protoCmd,
            out,
            protoPattern: args["proto-pattern"],
            ...postProcessOptions,
            enableCjs: args["enable-cjs"],
          })
        )
      )
    )
  )
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
