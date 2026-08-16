/** The `sysmon` namespace dictionaries: copy for the plugin settings card. */

export const zh = {
  'settings.title': '系统性能看板',
  'settings.description': '右下角悬浮窗实时显示 CPU/内存/磁盘/网络/负载。',
  'settings.enabled': '启用性能看板',
  'settings.enabledHint': '关闭后隐藏悬浮窗并停止采集，可在设置里重新启用。',
  'settings.cacheMs': '采集间隔（毫秒）',
  'settings.cacheMsHint': '两次采集之间的最小间隔，范围 100–60000。',
  'settings.inherit': '继承',
  'settings.on': '开',
  'settings.off': '关',
  'settings.overridden': '已覆盖',
  'settings.reset': '恢复默认',
  'settings.invalidNumber': '请输入数字，留空则使用默认值。',
  'settings.notExposed': '当前 DSH 版本未向设置页暴露本插件的配置命名空间，表单不可用。可编辑 ~/.dsh/settings.yaml 直接配置，或为 dsh-host-apiproxy 的 WEB_SETTINGS_NAMESPACES 白名单补充本命名空间后重启。',
  'settings.readOnly': '当前部署的设置只读。',
  'settings.expand': '展开设置',
  'settings.collapse': '收起设置',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.discard': '放弃',
  'settings.unsaved': '未保存',
  'settings.saveFailed': '部署未接受这些值，已保留供你修改。',
} satisfies Record<string, string>

/** The sysmon key union. */
export type SysmonLocaleKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<SysmonLocaleKey, string> = {
  'settings.title': 'System Performance Dashboard',
  'settings.description': 'A floating window showing live CPU/memory/disk/network/load.',
  'settings.enabled': 'Enable dashboard',
  'settings.enabledHint': 'Hides the floating window and stops collection when off; re-enable here.',
  'settings.cacheMs': 'Poll interval (ms)',
  'settings.cacheMsHint': 'Minimum interval between collector reads, 100–60000.',
  'settings.inherit': 'Inherit',
  'settings.on': 'On',
  'settings.off': 'Off',
  'settings.overridden': 'Overridden',
  'settings.reset': 'Reset',
  'settings.invalidNumber': 'Enter a number, or leave blank for the default.',
  'settings.notExposed': 'This DSH version does not expose this plugin\'s settings namespace to the configuration page, so the form is unavailable. Edit ~/.dsh/settings.yaml directly, or add the namespace to dsh-host-apiproxy\'s WEB_SETTINGS_NAMESPACES allowlist and restart.',
  'settings.readOnly': 'This deployment\'s settings are read-only.',
  'settings.expand': 'Expand settings',
  'settings.collapse': 'Collapse settings',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.discard': 'Discard',
  'settings.unsaved': 'Unsaved',
  'settings.saveFailed': 'The deployment did not accept these values; they were kept for editing.',
}
