//https://github.com/actions/toolkit/tree/main/packages/
import {PathOrFileDescriptor} from "fs";
import {
    cmd,
    deleteBranchPrefix, getTicketNumbers,
    isEmpty,
    LINE_SEPARATOR,
    replaceNullWithEmptyMap,
    ResultType,
    sortMap,
    toCommitMessages,
    toSemanticCommit
} from './common_processing';
import {addContext} from './context_processor';

const fs = require('fs');
const core = require('@actions/core');
const github = require('@actions/github');

//FILE ENDINGS
const fileEndingsMap = new Map<string, string[]>(
    [["js", [".js", ".mjs", ".cjs"]],
        ["ts", [".ts", ".tsx"]],
        ["python", [".py", ".pyc", ".pyd", ".pyo"]],
        ["java", [".java", ".class", ".jar", ".jav", ".jsp", ".jspf", ".jsf", ".groovy"]],
        ["kotlin", [".kt", ".kts"]],
        ["cs", [".cs", ".dll"]],
        ["cpp", [".c", ".cpp", ".h", ".hpp", ".o", ".a"]],
        ["ruby", [".rb", ".rbw", ".rake", ".gemspec"]],
        ["php", [".php", ".phtml", ".php3", ".php4", ".php5", ".phps"]],
        ["swift", [".swift", ".swiftdoc", ".swiftmodule"]],
        ["go", [".go", ".a", ".o"]],
        ["shell", [".sh", ".bash", ".csh", ".tcsh", ".ksh", ".zsh", ".fish", ".bat", ".cmd"]],
        ["perl", [".pl", ".pm", ".pod", ".t"]],
        ["lua", [".lua"]],
        ["r", [".r", ".R"]],
        ["sql", [".sql", ".ddl", ".dml"]],
        ["html", [".html", ".htm", ".xhtml"]],
        ["css", [".css", "scss"]],
        ["xml", [".xml"]],
        ["json", [".json"]],
        ["yaml", [".yml", ".yaml"]],
        ["config", [".config", ".ini", ".cfg", ".conf", ".properties", ".yml", ".yaml"]],
        ["json", [".json"]],
        ["envs", [".env"]],
        ["toml", [".toml"]],
        ["md", [".md", ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn", ".mdtxt", ".mdtext", ".mdml"]],
        ["text", [".txt", ".text",]],
        ["pictures", [".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".heic", ".svg", ".webp", ".avif", ".raw"]],
    ]);

try {
    let workDir = core.getInput('work-dir');
    let ignoreFilesStr = core.getInput('ignore-files') || null;
    let branchFallback = core.getInput('branch-fallback') || null;
    let tagFallback = core.getInput('tag-fallback') || null;
    let fallbackCommitType = core.getInput('fallback-commit-type');
    let fallbackCommitScope = core.getInput('fallback-commit-scope');
    let commitMsgWithFooter = core.getInput('commit-msg-with-footer');
    let nullToEmpty = core.getInput('null-to-empty');
    let workspace = process.env['GITHUB_WORKSPACE']?.toString() || null;
    if (!workDir || workDir === ".") {
        workDir = getWorkingDirectory(workspace);
    }
    let ignoreFiles = isEmpty(ignoreFilesStr) ? new Set<string>() : ignoreFilesStr.split(',');
    let result = run(
        github.context,
        workDir,
        ignoreFiles,
        branchFallback,
        tagFallback,
        !isEmpty(fallbackCommitType) ? fallbackCommitType : "",
        !isEmpty(fallbackCommitScope) ? fallbackCommitScope : "",
        !isEmpty(commitMsgWithFooter) ? commitMsgWithFooter.toLowerCase() === 'true' : true,
        !isEmpty(nullToEmpty) ? nullToEmpty.toLowerCase() === 'true' : true
    );
    result.set('GITHUB_WORKSPACE', workspace || null);

    console.log(JSON.stringify(Object.fromEntries(sortMap(result)), null, 4));

    result.forEach((value, key) => {
        core.setOutput(key, value);
    });
} catch (e) {
    if (typeof e === "string") {
        core.setFailed(e.toUpperCase());
    } else if (e instanceof Error) {
        core.setFailed(e.message);
    }
}

function run(
    context: any,
    workDir: PathOrFileDescriptor,
    ignoreFiles: Set<string>,
    branchFallback: string,
    tagFallback: string,
    fallbackCommitType: string,
    fallbackCommitScope: string,
    commitMsgWithFooter: boolean,
    nullToEmpty: boolean
): Map<string, ResultType> {
    //DEFAULTS
    let result = new Map<string, ResultType>();
    branchFallback = isEmpty(branchFallback) ? 'main' : branchFallback
    ignoreFiles = new Set(Array.from(ignoreFiles, s => s.trim()));
    result.set('work-dir', workDir.toString());
    result.set('ignore-files', Array.from(ignoreFiles).join(", ") || null);
    result.set('branch-fallback', branchFallback);
    result.set('tag-fallback', tagFallback);
    result.set('fallback-commit-type', fallbackCommitType);
    result.set('fallback-commit-scope', fallbackCommitScope);
    result.set('commit-msg-with-footer', commitMsgWithFooter);
    result.set('ticket_numbers', "");
    result.set('has_breaking_changes', false);
    result.set("commit_types", "");
    result.set("commit_scopes", "");
    addContext(result, context);

    cmd(workDir, 'git fetch --all --tags');
    result.set('is_git_repo', !isEmpty(cmd(workDir, 'git rev-parse --is-inside-work-tree', 'git rev-parse --git-dir')));
    result.set('branch', deleteBranchPrefix(context?.payload?.ref || context?.ref || cmd(workDir, 'git branch --show-current', 'git branch --show', 'git rev-parse --abbrev-ref HEAD', 'git rev-parse --abbrev-ref --symbolic-full-name @{u}')));
    result.set('branch_default', context?.repository?.default_branch || getDefaultBranch(workDir, branchFallback));
    result.set('is_default_branch', result.get('branch') === result.get('branch_default') && result.get('branch') !== null);
    result.set('sha_latest', cmd(workDir, 'git rev-parse HEAD'));
    result = setLatestTag(workDir, result, tagFallback);
    result.set('has_changes', result.get('sha_latest') !== result.get('sha_latest_tag'));

    addChanges(ignoreFiles, workDir, result);
    addAheadBehind(workDir, result);
    addSemCommits(result, workDir, fallbackCommitType, fallbackCommitScope, commitMsgWithFooter);
    return sortMap(nullToEmpty ? replaceNullWithEmptyMap(result) : result);
}


function addAheadBehind(workDir: string | Buffer | URL | number, result: Map<string, ResultType>) {
    let aheadBehind = cmd(workDir, 'git rev-list --count --left-right ' + result.get('branch') + '...' + result.get('branch_default'));
    let ahead = isEmpty(aheadBehind) ? null : aheadBehind?.split(/\s/)[0].trim();
    let behind = isEmpty(aheadBehind) ? null : aheadBehind?.split(/\s/)[1].trim();
    result.set('commits_ahead', parseInt(ahead || '0'));
    result.set('commits_behind', parseInt(behind || '0'));
}

function addChanges(ignoreFiles: Set<string>, workDir: string | Buffer | URL | number, result: Map<string, ResultType>) {
    let gitStatus = cmd(workDir, 'git status --porcelain');
    let changedFiles = toFilesSet(ignoreFiles, cmd(workDir, 'git diff ' + result.get('sha_latest') + ' ' + result.get('sha_latest_tag') + ' --name-only'));
    let changedLocalFiles = toFilesSet(ignoreFiles, gitStatus);
    result.set('has_local_changes', changedLocalFiles && changedLocalFiles.size > 0);
    fileEndingsMap.forEach((fileEndings, language) => {
        result.set('x_has_local_changes_' + language.toLowerCase(), hasFileEnding(changedLocalFiles, fileEndings));
    });
    fileEndingsMap.forEach((fileEndings, language) => {
        result.set('x_has_changes_' + language.toLowerCase(), hasFileEnding(changedFiles, fileEndings));
    });
    let languages = Array.from(fileEndingsMap.keys());
    languages.sort();
    result.set('x_language_list', languages.join(', '));
}

function addSemCommits(result: Map<string, ResultType>, workDir: string | Buffer | URL | number, fallbackCommitType: string, fallbackCommitScope: string, commitMsgWithFooter: boolean) {
    if (result.get("has_changes")) {
        let commits = toCommitMessages(cmd(workDir, 'git log ' + result.get('sha_latest_tag') + '..' + result.get('sha_latest')))
            .map(commit => toSemanticCommit(commit[3], fallbackCommitType, fallbackCommitScope, commitMsgWithFooter));
        result.set("ticket_numbers", getTicketNumbers(commits).join(', '));
        result.set("has_breaking_changes", commits.some(([_, __, breakingChange]) => !isEmpty(breakingChange) ? breakingChange.toLowerCase() === 'true' : false));

        let typeMap = new Map<string, string[]>();
        let scopeMap = new Map<string, string[]>();
        commits.forEach(commit => {
            if (commit.length >= 1 && !isEmpty(commit[0])) {
                let message = typeMap.has(commit[0]) ? typeMap.get(commit[0])! : [];
                message.push(commit[3]);
                typeMap.set(commit[0], message);
            }
            if (commit.length >= 2 && !isEmpty(commit[1])) {
                let message = scopeMap.has(commit[1]) ? scopeMap.get(commit[1])! : [];
                message.push(commit[3]);
                scopeMap.set(commit[1], message);
            }
        });
        result.set("commit_types", Array.from(sortMap(typeMap).keys()).join(', '));
        result.set("commit_scopes", Array.from(sortMap(scopeMap).keys()).join(', '));
        typeMap.forEach((value, key) => {
            result.set("commit_type_" + key, value.join(`. ${LINE_SEPARATOR}`));
        });
        scopeMap.forEach((value, key) => {
            result.set("commit_scope_" + key, value.join(`. ${LINE_SEPARATOR}`));
        });
    }
}

function toFilesSet(ignoreFiles: Set<string>, changesLog: string | null): Set<string> {
    let result = new Set<string>();
    if (isEmpty(changesLog) || changesLog === null) {
        return result;
    }
    for (const line of changesLog.split(/\r?\n|\r/)) {
        if (!isEmpty(line) && line.includes('.')) {
            result.add(line.trim());
        }
    }
    return ignoreFiles && ignoreFiles.size > 0
        ? new Set(Array.from(result).filter(file => {
            return !Array.from(ignoreFiles).some(regex => new RegExp(regex).test(file));
        }))
        : result;
}

function hasFileEnding(fileNames: Set<string>, fileEndings: string[]): boolean {
    return Array.from(fileNames).some(fileName => {
        return fileEndings.some(ending => fileName.toLowerCase().endsWith(ending.toLowerCase()));
    });
}

function setLatestTag(workDir: PathOrFileDescriptor, result: Map<string, ResultType>, tagFallback: string): Map<string, ResultType> {
    let latestTag = cmd(workDir, 'git describe --tags --abbrev=0');
    if (!isEmpty(latestTag)) {
        result.set('tag_latest', latestTag);
        result.set('sha_latest_tag', cmd(workDir, 'git rev-list -n 1 ' + latestTag));
    } else {
        result.set('tag_latest', isEmpty(tagFallback) ? null : tagFallback);
        result.set('sha_latest_tag', result.get('sha_latest') || null);
    }
    return result;
}

function getDefaultBranch(workDir: PathOrFileDescriptor, fallback: string): string {
    let result = deleteBranchPrefix(cmd(workDir, 'git symbolic-ref refs/remotes/origin/HEAD', 'git symbolic-ref refs/remotes/origin/HEAD'));
    result = isEmpty(result) ? deleteBranchPrefix(cmd(workDir, 'git symbolic-ref HEAD')) : result;
    result = !isEmpty(result) && result != null ? result.trim() : result;
    return isEmpty(result) || result == null ? fallback : result;
}

function getWorkingDirectory(workspace: string | undefined | null): PathOrFileDescriptor {
    return workspace && fs.existsSync(workspace) ? workspace : process.cwd();
}

module.exports = {run};
